// On-disk cache of (parallel-downloaded) source media files, used to
// speed up ffmpeg operations like subtitle extraction.
//
// Why this exists:
// ffmpeg over HTTP against TorBox's CDN is bandwidth-bound by a single
// TCP connection (typically capped at 30-50 Mbps per stream). For a
// 1.4 GB MKV that means 2-3 minutes just to skim the file. A parallel
// downloader using 8 concurrent HTTP range requests can saturate the
// LAN-to-CDN pipe (multi-hundred Mbps), cutting the same download to
// 10-30 s. Once the file is on local disk, ffmpeg reads at disk speed
// — subtitle extraction completes in seconds instead of minutes.
//
// Lifecycle:
//   1. /api/v1/stream/hls/.../prep asks for the source.
//   2. ensureLocalSource returns the cached path if present, else
//      kicks off downloadSourceParallel.
//   3. Files live under <datadir>/cache/sources/ keyed by sha256 of the
//      source URL. A background reaper prunes files older than 24h
//      and trims to a 20 GB cap on next access.

package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// 16 parallel connections. Empirically TorBox doesn't rate-limit
	// per-IP, so doubling from 8 → 16 nets a measurable speedup on
	// fat pipes (LAN-to-CDN > 100 Mbps). Drop back to 8 if you're
	// on a slow / metered link.
	sourceDownloadConcurrency = 16
	// 8 MB chunks balance overhead vs adaptive parallelism. Too small
	// and we pay per-request handshake repeatedly; too big and a
	// single slow chunk holds up the others.
	sourceDownloadChunkSize = 8 << 20 // 8 MiB
	// Hard upper bound on disk consumption. When exceeded, the
	// reaper deletes oldest files until we're under.
	sourceCacheMaxBytes = 20 << 30 // 20 GiB
	// Files older than this get reaped on next access even if we're
	// well under the size cap. Keeps the cache from hoarding stale
	// releases.
	sourceCacheTTL = 24 * time.Hour
)

// One-flight per cache key — multiple callers asking for the same URL
// share a single download instead of racing to write the same file.
var (
	sourceCacheMu       sync.Mutex
	sourceCacheInFlight = map[string]*sourceDownload{}
)

type sourceDownload struct {
	path  string
	err   error
	done  chan struct{}
	bytes int64
	total int64
}

// localSourceIfReady returns the cached path + true iff the source has
// already been downloaded to disk in full. Cheap (single stat call),
// safe to call on the hot path. Does NOT trigger a download.
func (h *Handler) localSourceIfReady(sourceURL string) (string, bool) {
	cacheDir := filepath.Join(h.App.Config.Data.Dir, "cache", "sources")
	key := sourceCacheKey(sourceURL)
	path := filepath.Join(cacheDir, key+".bin")
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		// Touch mtime so LRU keeps it alive.
		now := time.Now()
		_ = os.Chtimes(path, now, now)
		return path, true
	}
	return "", false
}

// warmLocalSource kicks off a background parallel download if the cache
// file is missing AND there's not already one in flight. Idempotent;
// repeated calls collapse into a single download via the in-flight
// coalescer inside ensureLocalSource.
func (h *Handler) warmLocalSource(sourceURL string) {
	if _, ready := h.localSourceIfReady(sourceURL); ready {
		return
	}
	key := sourceCacheKey(sourceURL)
	sourceCacheMu.Lock()
	if _, inflight := sourceCacheInFlight[key]; inflight {
		sourceCacheMu.Unlock()
		return
	}
	sourceCacheMu.Unlock()
	// 15 min hard cap on background warmup — should never need that
	// long but bounds the goroutine lifetime if TorBox stalls.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	if _, err := h.ensureLocalSource(ctx, sourceURL, nil); err != nil {
		log.Printf("source warmup failed: %v", err)
	}
}

// ensureLocalSource returns the local file path for the given URL,
// downloading in parallel if not already cached. progressCb receives
// (downloadedBytes, totalBytes) callbacks during the download phase.
//
// Callers that hit the cache get progressCb(total, total) once before
// the path is returned, so consumers can update UI consistently.
func (h *Handler) ensureLocalSource(ctx context.Context, sourceURL string, progressCb func(downloaded, total int64)) (string, error) {
	cacheDir := filepath.Join(h.App.Config.Data.Dir, "cache", "sources")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return "", err
	}
	key := sourceCacheKey(sourceURL)
	path := filepath.Join(cacheDir, key+".bin")

	// Best-effort prune on each access; cheap because it only stats
	// the cache directory.
	go pruneSourceCache(cacheDir)

	// Fast path: cache hit.
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		// Refresh mtime so LRU keeps this one alive.
		now := time.Now()
		_ = os.Chtimes(path, now, now)
		if progressCb != nil {
			progressCb(info.Size(), info.Size())
		}
		return path, nil
	}

	// Coalesce concurrent callers for the same URL.
	sourceCacheMu.Lock()
	if inflight, ok := sourceCacheInFlight[key]; ok {
		sourceCacheMu.Unlock()
		<-inflight.done
		if inflight.err != nil {
			return "", inflight.err
		}
		if progressCb != nil {
			progressCb(inflight.total, inflight.total)
		}
		return inflight.path, nil
	}
	dl := &sourceDownload{path: path, done: make(chan struct{})}
	sourceCacheInFlight[key] = dl
	sourceCacheMu.Unlock()

	defer func() {
		sourceCacheMu.Lock()
		delete(sourceCacheInFlight, key)
		sourceCacheMu.Unlock()
		close(dl.done)
	}()

	wrappedCb := func(downloaded, total int64) {
		dl.bytes = downloaded
		dl.total = total
		if progressCb != nil {
			progressCb(downloaded, total)
		}
	}

	if err := downloadSourceParallel(ctx, sourceURL, path, sourceDownloadConcurrency, sourceDownloadChunkSize, wrappedCb); err != nil {
		dl.err = err
		// Clean up the partial file so the next call can retry.
		_ = os.Remove(path)
		_ = os.Remove(path + ".tmp")
		return "", err
	}
	return path, nil
}

// downloadSourceParallel splits the resource into chunks and downloads
// them concurrently. Each worker pulls a range and writes at the file
// offset via pwrite. Final atomic rename from .tmp on full success.
func downloadSourceParallel(ctx context.Context, url, destPath string, concurrency int, chunkSize int64, progressCb func(downloaded, total int64)) error {
	if concurrency < 1 {
		concurrency = 1
	}
	if chunkSize < 1 {
		chunkSize = sourceDownloadChunkSize
	}

	// 1. HEAD to learn the file size + confirm range support.
	headReq, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return err
	}
	headClient := &http.Client{Timeout: 30 * time.Second}
	headRes, err := headClient.Do(headReq)
	if err != nil {
		return err
	}
	headRes.Body.Close()
	if headRes.StatusCode >= 400 {
		return fmt.Errorf("HEAD %s: %s", url, headRes.Status)
	}
	total := headRes.ContentLength
	if total <= 0 {
		return fmt.Errorf("HEAD %s: missing Content-Length", url)
	}
	acceptsRanges := headRes.Header.Get("Accept-Ranges") == "bytes"

	tmpPath := destPath + ".tmp"
	f, err := os.OpenFile(tmpPath, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := f.Truncate(total); err != nil {
		return err
	}

	log.Printf("dl: %s → %s (size=%dMB, concurrency=%d, chunk=%dMB)",
		url, filepath.Base(destPath), total/1024/1024, concurrency, chunkSize/1024/1024)
	start := time.Now()

	// If server doesn't support ranges fall back to a single-stream pull.
	if !acceptsRanges {
		log.Printf("dl: server doesn't support Accept-Ranges, single-stream download")
		return downloadSingleStream(ctx, url, f, total, progressCb)
	}

	// Generate chunk ranges.
	type chunkRange struct{ start, end int64 } // end inclusive (HTTP Range)
	var chunks []chunkRange
	for off := int64(0); off < total; off += chunkSize {
		end := off + chunkSize - 1
		if end >= total {
			end = total - 1
		}
		chunks = append(chunks, chunkRange{off, end})
	}

	var (
		downloaded int64
		errOnce    sync.Once
		firstErr   error
	)
	jobs := make(chan chunkRange, len(chunks))
	for _, c := range chunks {
		jobs <- c
	}
	close(jobs)

	// Spawn workers.
	var wg sync.WaitGroup
	httpClient := &http.Client{
		Timeout: 0, // per-range read controlled via context
		Transport: &http.Transport{
			MaxIdleConns:        concurrency * 2,
			MaxConnsPerHost:     concurrency * 2,
			MaxIdleConnsPerHost: concurrency * 2,
			IdleConnTimeout:     30 * time.Second,
		},
	}
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for c := range jobs {
				if ctx.Err() != nil {
					return
				}
				if err := downloadChunk(ctx, httpClient, url, f, c.start, c.end, &downloaded, progressCb, total); err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
			}
		}()
	}
	wg.Wait()

	if firstErr != nil {
		_ = os.Remove(tmpPath)
		return firstErr
	}
	if err := f.Sync(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}

	elapsed := time.Since(start)
	mbps := float64(total) / 1024 / 1024 / elapsed.Seconds()
	log.Printf("dl: %s done in %s (%.1f MB/s)", filepath.Base(destPath), elapsed.Round(time.Second), mbps)
	if progressCb != nil {
		progressCb(total, total)
	}
	return nil
}

// downloadChunk pulls one byte range and pwrites it into the destination
// file. Retries are handled at the caller level (we just return errors).
func downloadChunk(ctx context.Context, client *http.Client, url string, f *os.File, start, end int64, downloaded *int64, cb func(int64, int64), total int64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusPartialContent && res.StatusCode != http.StatusOK {
		return fmt.Errorf("range %d-%d: %s", start, end, res.Status)
	}

	// Stream into the file at the right offset, reporting bytes as we go.
	buf := make([]byte, 64*1024)
	offset := start
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := f.WriteAt(buf[:n], offset); werr != nil {
				return werr
			}
			offset += int64(n)
			cur := atomic.AddInt64(downloaded, int64(n))
			if cb != nil {
				cb(cur, total)
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// downloadSingleStream — fallback for servers that don't expose
// Accept-Ranges: bytes. Single HTTP GET, sequential write.
func downloadSingleStream(ctx context.Context, url string, f *os.File, total int64, cb func(int64, int64)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 0}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return fmt.Errorf("%s: %s", url, res.Status)
	}
	buf := make([]byte, 256*1024)
	var downloaded int64
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, werr := f.WriteAt(buf[:n], downloaded); werr != nil {
				return werr
			}
			downloaded += int64(n)
			if cb != nil {
				cb(downloaded, total)
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

func sourceCacheKey(url string) string {
	h := sha256.Sum256([]byte(url))
	return hex.EncodeToString(h[:16])
}

// pruneSourceCache evicts cached source files older than sourceCacheTTL
// and trims the directory to sourceCacheMaxBytes via simple LRU
// (oldest mtime first). Best effort — errors are silently logged.
//
// Safe to call concurrently; the work is read-only stats plus os.Remove
// which is atomic per file.
func pruneSourceCache(cacheDir string) {
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}
	type fileInfo struct {
		path  string
		size  int64
		mtime time.Time
	}
	files := make([]fileInfo, 0, len(entries))
	now := time.Now()
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{
			path:  filepath.Join(cacheDir, e.Name()),
			size:  info.Size(),
			mtime: info.ModTime(),
		})
	}

	// Phase 1: drop anything past TTL.
	totalSize := int64(0)
	live := make([]fileInfo, 0, len(files))
	for _, f := range files {
		if now.Sub(f.mtime) > sourceCacheTTL {
			if err := os.Remove(f.path); err == nil {
				log.Printf("source cache: reaped TTL-expired %s (%dMB)", filepath.Base(f.path), f.size/1024/1024)
			}
			continue
		}
		live = append(live, f)
		totalSize += f.size
	}

	if totalSize <= sourceCacheMaxBytes {
		return
	}

	// Phase 2: LRU until under the cap.
	sort.Slice(live, func(i, j int) bool {
		return live[i].mtime.Before(live[j].mtime)
	})
	for _, f := range live {
		if totalSize <= sourceCacheMaxBytes {
			return
		}
		if err := os.Remove(f.path); err == nil {
			log.Printf("source cache: reaped LRU %s (%dMB) to stay under cap", filepath.Base(f.path), f.size/1024/1024)
			totalSize -= f.size
		}
	}
}
