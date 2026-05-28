package library

import (
	"context"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"notflix/internal/database/db"
	"notflix/internal/database/models"
)

// MKV → MP4 batch converter.
//
// Purpose: a lot of release MKVs ship with AC-3 / E-AC-3 / DTS / TrueHD
// audio that Chrome and Firefox can't decode natively. The simplest
// fix is to remux/transmux them to MP4:
//
//	If source audio is AAC      → ffmpeg -c:v copy -c:a copy out.mp4
//	                              (pure container change, seconds)
//	Otherwise (AC-3, DTS, …)    → ffmpeg -c:v copy -c:a aac out.mp4
//	                              (audio transcoded, ~30 s for a 2 h film)
//
// On success, the source .mkv is deleted from disk. The fsnotify
// watcher picks up the new .mp4 immediately and indexes it; the next
// auto-scan removes the dead .mkv row from the DB.
//
// State is package-level on purpose (process-wide single batch job),
// just like the scan runner.

type ConvertProgress struct {
	Running     bool      `json:"running"`
	Total       int       `json:"total"`
	Current     int       `json:"current"`
	CurrentFile string    `json:"currentFile,omitempty"`
	Succeeded   int       `json:"succeeded"`
	Skipped     int       `json:"skipped"` // already a .mp4 sibling exists
	Failed      int       `json:"failed"`
	Errors      []string  `json:"errors,omitempty"`
	StartedAt   time.Time `json:"startedAt,omitempty"`
	FinishedAt  time.Time `json:"finishedAt,omitempty"`
}

var (
	convertMu     sync.RWMutex
	convertState  ConvertProgress
	convertCancel context.CancelFunc
)

// ConvertSnapshot returns a copy of the current batch state.
func ConvertSnapshot() ConvertProgress {
	convertMu.RLock()
	defer convertMu.RUnlock()
	// Deep-copy Errors so the caller can't mutate our slice.
	errs := make([]string, len(convertState.Errors))
	copy(errs, convertState.Errors)
	snap := convertState
	snap.Errors = errs
	return snap
}

// TryStartConvertBatch kicks off a batch in a goroutine. Returns false
// if a batch is already running.
func TryStartConvertBatch(store *db.Database) bool {
	convertMu.Lock()
	if convertState.Running {
		convertMu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	convertCancel = cancel
	convertState = ConvertProgress{
		Running:   true,
		StartedAt: time.Now(),
	}
	convertMu.Unlock()

	go runConvertBatch(ctx, store)
	return true
}

// CancelConvertBatch stops the currently-running batch. No-op if idle.
func CancelConvertBatch() {
	convertMu.Lock()
	defer convertMu.Unlock()
	if convertCancel != nil {
		convertCancel()
	}
}

func runConvertBatch(ctx context.Context, store *db.Database) {
	defer func() {
		convertMu.Lock()
		convertState.Running = false
		convertState.FinishedAt = time.Now()
		convertCancel = nil
		convertMu.Unlock()
	}()

	files, err := store.ListAllLocalFiles()
	if err != nil {
		log.Printf("convert batch: list files: %v", err)
		return
	}

	// Filter to MKVs only (case-insensitive).
	var mkvs []*models.LocalFile
	for _, f := range files {
		if strings.EqualFold(filepath.Ext(f.Path), ".mkv") {
			mkvs = append(mkvs, f)
		}
	}

	convertMu.Lock()
	convertState.Total = len(mkvs)
	convertMu.Unlock()

	if len(mkvs) == 0 {
		log.Printf("convert batch: no MKV files to convert")
		return
	}

	log.Printf("convert batch: %d MKV(s) to process", len(mkvs))

	for i, f := range mkvs {
		if ctx.Err() != nil {
			log.Printf("convert batch: cancelled at %d/%d", i, len(mkvs))
			return
		}
		convertMu.Lock()
		convertState.Current = i + 1
		convertState.CurrentFile = filepath.Base(f.Path)
		convertMu.Unlock()

		outcome, errMsg := convertOne(ctx, f.Path)

		convertMu.Lock()
		switch outcome {
		case "ok":
			convertState.Succeeded++
		case "skipped":
			convertState.Skipped++
		default:
			convertState.Failed++
			if errMsg != "" {
				// Cap error list so it doesn't blow up over a giant batch.
				if len(convertState.Errors) < 20 {
					convertState.Errors = append(convertState.Errors,
						fmt.Sprintf("%s: %s", filepath.Base(f.Path), errMsg))
				}
			}
		}
		convertMu.Unlock()
	}

	convertMu.RLock()
	log.Printf("convert batch: done — %d ok, %d skipped, %d failed",
		convertState.Succeeded, convertState.Skipped, convertState.Failed)
	convertMu.RUnlock()
}

// convertOne does the actual ffmpeg call for one MKV.
//   - Returns "ok"      → conversion succeeded, .mkv deleted
//   - Returns "skipped" → a .mp4 with the same basename already exists
//                         (we don't overwrite, the user can clean up)
//   - Returns "failed"  → ffmpeg/output/delete error; errMsg explains
func convertOne(ctx context.Context, mkvPath string) (outcome, errMsg string) {
	srcInfo, err := os.Stat(mkvPath)
	if err != nil {
		return "failed", "source missing: " + err.Error()
	}

	// Output path = same dir, same basename, .mp4 (handles MKV and mkv).
	ext := filepath.Ext(mkvPath)
	outPath := strings.TrimSuffix(mkvPath, ext) + ".mp4"

	if _, err := os.Stat(outPath); err == nil {
		// Sibling .mp4 already there — don't overwrite. Could be a
		// previous successful conversion that left the .mkv as a
		// leftover; the admin can delete it manually.
		return "skipped", ""
	}

	// Disk space check. We need roughly source size in the same
	// directory (video is copy-muxed, audio is re-encoded so size
	// is comparable). Use 1.2× as a safety margin. Skip with a
	// clear error instead of letting ffmpeg churn for minutes only
	// to fail on "No space left on device".
	srcBytes := uint64(srcInfo.Size())
	needBytes := srcBytes * 6 / 5
	if free := freeBytesAt(filepath.Dir(outPath)); free > 0 && free < needBytes {
		return "failed", fmt.Sprintf(
			"espace insuffisant : %s libre, %s requis",
			humanBytes(free), humanBytes(needBytes),
		)
	}

	// Probe both audio and video codecs so we can pick the right
	// flags. Video matters for HEVC: the MP4 brand defaults to
	// `hev1` but Chrome / Safari need `hvc1` to play HEVC tracks.
	audio := probeAudioCodec(ctx, mkvPath)
	video := probeVideoCodec(ctx, mkvPath)
	log.Printf("convert: %s (video=%q audio=%q)",
		filepath.Base(mkvPath), video, audio)

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-y", // we already checked outPath doesn't exist; -y avoids the prompt
		"-i", mkvPath,
		"-c:v", "copy", // bit-perfect video copy
		"-map_metadata", "0",
		"-map", "0:v:0",
		"-map", "0:a:0?", // optional audio map — files without an audio track skip the audio side
	}
	// HEVC in MP4 needs the `hvc1` brand to play in Chrome/Safari.
	// Without `-tag:v hvc1`, ffmpeg writes `hev1` which the browsers
	// silently refuse. For non-HEVC sources the tag is auto (avc1
	// for H.264, etc) — only apply it when we know we're on HEVC.
	if isHEVC(video) {
		args = append(args, "-tag:v", "hvc1")
	}
	if strings.EqualFold(audio, "aac") {
		// Pure container change. Should take a few seconds for any
		// size; ffmpeg is just rewriting MP4 boxes.
		args = append(args, "-c:a", "copy")
	} else {
		// Transcode audio to AAC stereo 192 kb/s. Quick (a few seconds
		// of audio per second of wall time on a modern CPU).
		args = append(args, "-c:a", "aac", "-b:a", "192k", "-ac", "2")
	}
	args = append(args,
		// faststart moves the moov to the front so the browser can
		// start playback before the whole file downloads.
		"-movflags", "+faststart",
		outPath,
	)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// Tidy up the partial / corrupt output.
		_ = os.Remove(outPath)
		if ctx.Err() != nil {
			return "failed", "cancelled"
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		return "failed", msg
	}

	// Sanity check the output.
	info, err := os.Stat(outPath)
	if err != nil || info.Size() == 0 {
		_ = os.Remove(outPath)
		return "failed", "ffmpeg produced no output"
	}

	// Delete the source MKV. If this fails, we still consider the
	// conversion successful — the MP4 is valid; the user can clean up
	// the MKV manually later.
	if err := os.Remove(mkvPath); err != nil {
		log.Printf("convert: removed %s mp4 but couldn't delete .mkv: %v",
			filepath.Base(outPath), err)
	}

	return "ok", ""
}

// probeAudioCodec returns the first audio stream's codec name (lower
// case, eg "aac" / "ac3" / "eac3" / "dts" / "truehd"), or "" if
// ffprobe fails. Used to pick between -c:a copy and -c:a aac.
func probeAudioCodec(ctx context.Context, path string) string {
	return probeFirstStreamCodec(ctx, path, "a:0")
}

// probeVideoCodec returns the first video stream's codec name (lower
// case, eg "h264" / "hevc" / "av1"). Drives the HEVC brand fix
// (`-tag:v hvc1`) inside convertOne.
func probeVideoCodec(ctx context.Context, path string) string {
	return probeFirstStreamCodec(ctx, path, "v:0")
}

func probeFirstStreamCodec(ctx context.Context, path, selector string) string {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", selector,
		"-show_entries", "stream=codec_name",
		"-of", "default=noprint_wrappers=1:nokey=1",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.ToLower(string(out)))
}

// isHEVC matches the ffprobe names for H.265 / HEVC streams. ffprobe
// usually reports "hevc" but some builds say "h265" — accept both.
func isHEVC(codec string) bool {
	c := strings.ToLower(codec)
	return c == "hevc" || c == "h265" || c == "h.265"
}

// freeBytesAt returns the number of bytes available to a non-root
// user on the filesystem that hosts `path`. Returns 0 if the call
// fails (caller treats that as "unknown" and proceeds).
//
// Works on macOS + Linux via syscall.Statfs_t. Windows would need
// a different code path but Notflix doesn't deploy there.
func freeBytesAt(path string) uint64 {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0
	}
	// Bavail = blocks free to a non-root user. Bsize = block size.
	// Cast Bsize through int64 → uint64 since its underlying type
	// is int32 on Linux and int32 on macOS.
	return stat.Bavail * uint64(stat.Bsize)
}

// humanBytes formats n into a short SI-ish string ("4.3 GB", "789 MB").
// Used in error messages so the user sees real numbers instead of
// raw byte counts.
func humanBytes(n uint64) string {
	if n == 0 {
		return "0 B"
	}
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	v := float64(n)
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	// 1 decimal under 10, integer above (so "4.3 GB" but "256 GB").
	if v < 10 {
		return fmt.Sprintf("%.1f %s", v, units[i])
	}
	return fmt.Sprintf("%.0f %s", math.Round(v), units[i])
}
