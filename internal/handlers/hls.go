package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// HLS transmux — on-demand segment transcoding.
//
// Why on-demand: a long-running ffmpeg writing segments linearly makes the
// browser's progress bar grow as the encode advances ("ce serait mieux
// d'avoir toute la durée du film d'un coup"). It also makes seek beyond
// the live edge wait for ffmpeg to catch up linearly — fine for a 4-min
// jump, terrible for "skip the intro" 45 min in.
//
// Plex / Jellyfin / Stash solve this with on-demand chunk transcoding:
//   1. ffprobe the source once to know total duration → pre-build a VOD
//      playlist with every segment numbered up front. The seek bar shows
//      the full length immediately.
//   2. When the browser requests segment_NNNNN.ts, spawn a small ffmpeg
//      that seeks to N * segDur, transcodes the next segDur worth, and
//      streams the bytes back. No temp files, no background process.
//
// Trade-off vs. linear-encode: each chunk pays ~0.5-1 s of ffmpeg
// startup. The browser pre-buffers two or three segments so this only
// stings on seek + restart. For sequential playback the next chunk
// kicks off while the current one plays, so it's invisible.

const hlsSegDurSec = 4.0

// SubtitleTrack describes one subtitle source we expose to the player.
// Embedded streams live inside the video file (extracted via ffmpeg);
// external tracks are separate .srt / .ass files shipped alongside
// the video in the same torrent.
//
// Codec → support matrix:
//   subrip / srt    → convertible to WebVTT          ✓
//   ass / ssa       → convertible to WebVTT          ✓ (styling stripped)
//   webvtt / vtt    → passthrough                     ✓
//   mov_text        → convertible                     ✓
//   pgssub / hdmv   → graphical, needs OCR            ✗
//   dvdsub / vobsub → graphical, needs OCR            ✗
type SubtitleTrack struct {
	// "embedded" (extracted from the video file) or "external"
	// (a separate file in the torrent). The frontend builds a
	// different URL per source: sub_<idx>.vtt vs ext_<idx>.vtt.
	Source    string `json:"source"`    // "embedded" | "external"
	Index     int    `json:"index"`     // 0-based, per-source
	Codec     string `json:"codec"`     // ffprobe codec_name (embedded) or file ext (external)
	Language  string `json:"language"`  // ISO-639 tag, e.g. "fre" / "eng" / "jpn"
	Title     string `json:"title"`     // Optional descriptive label
	Supported bool   `json:"supported"` // false for graphical subs we can't convert
}

// externalSub — internal record for the per-session list of external
// subtitle files. Not exported because the frontend only ever talks
// to it through the SubtitleTrack-shaped JSON.
type externalSub struct {
	URL      string // TorBox direct URL
	Filename string // For codec sniffing + label
	Language string
}

type hlsSession struct {
	id           string
	url          string
	duration     float64 // seconds, 0 if probe failed
	audioCodec   string
	subtitles    []SubtitleTrack
	externalSubs []externalSub // per-index URL/filename for ext_<idx>.vtt
	lastUsed     time.Time
}

var (
	hlsSessions    = map[string]*hlsSession{}
	hlsLock        sync.Mutex
	hlsCleanupOnce sync.Once
)

// HandleStreamHLSStart — POST /api/v1/stream/hls/start
//
// Body: {"url": "<torbox-cdn-url>", "durationSec"?: float, "audioCodec"?: string}
// Returns: {"sessionId", "playlistUrl", "durationSec", "audioCodec", "subtitles"}
//
// If the caller already ffprobed the URL (e.g. /torbox/play just did it),
// they can pass `durationSec` + `audioCodec` and the HLS handler skips
// the re-probe — saves ~1-2s on the second hop. Subtitles are always
// (re-)probed here so the session knows what tracks to expose via
// /sub_<idx>.vtt — there's no piggy-back-from-caller for that yet.
func (h *Handler) HandleStreamHLSStart(c echo.Context) error {
	var body struct {
		URL         string  `json:"url"`
		DurationSec float64 `json:"durationSec,omitempty"`
		AudioCodec  string  `json:"audioCodec,omitempty"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	raw := body.URL
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid url"})
	}
	if !isAllowedStreamHost(u.Host) {
		return c.JSON(http.StatusForbidden, map[string]any{
			"error": "host not allowed for hls: " + u.Host,
		})
	}

	sess, err := openHLSSession(c.Request().Context(), raw, body.DurationSec, body.AudioCodec, nil, nil)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
	}

	return RespondOK(c, map[string]any{
		"sessionId":   sess.id,
		"playlistUrl": "/api/v1/stream/hls/" + sess.id + "/index.m3u8",
		"durationSec": sess.duration,
		"audioCodec":  sess.audioCodec,
		"subtitles":   sess.subtitles,
	})
}

// openHLSSession opens (or refreshes) a session for the given source URL.
// Pulled out of HandleStreamHLSStart so /torbox/play can use the same
// machinery to expose subtitle URLs even for direct (non-transmux)
// playback.
//
// When `hintEmbedded` is non-nil the caller already ran probeMediaFull
// (i.e. /torbox/play just did) — we trust the result and skip a second
// probe. Otherwise we run one ourselves.
//
// `externals` are pre-resolved subtitle files (typically .srt / .ass
// from the same torrent). They appear in the session.subtitles list
// with Source="external".
func openHLSSession(parent context.Context, sourceURL string, hintDur float64, hintAudio string, hintEmbedded []SubtitleTrack, externals []externalSub) (*hlsSession, error) {
	digest := sha256.Sum256([]byte(sourceURL))
	sessionID := hex.EncodeToString(digest[:8])

	hlsLock.Lock()
	sess, exists := hlsSessions[sessionID]
	hlsLock.Unlock()

	if exists {
		hlsLock.Lock()
		sess.lastUsed = time.Now()
		hlsLock.Unlock()
		return sess, nil
	}

	var dur float64 = hintDur
	var audio string = hintAudio
	var embedded []SubtitleTrack = hintEmbedded
	if hintEmbedded == nil {
		// No probe yet — run our own.
		pDur, pAudio, pSubs := probeMediaFull(parent, sourceURL)
		if dur == 0 {
			dur = pDur
		}
		if audio == "" {
			audio = pAudio
		}
		embedded = pSubs
	}
	if dur == 0 {
		return nil, fmt.Errorf("ffprobe failed to read duration")
	}

	// Mark embedded subs with Source = "embedded" for the frontend.
	for i := range embedded {
		embedded[i].Source = "embedded"
	}

	// Build SubtitleTrack entries for the external files. Codec comes
	// from the file extension; language is guessed by the caller from
	// the filename.
	allSubs := append([]SubtitleTrack(nil), embedded...)
	for i, ext := range externals {
		codec := strings.TrimPrefix(strings.ToLower(filepath.Ext(ext.Filename)), ".")
		allSubs = append(allSubs, SubtitleTrack{
			Source:    "external",
			Index:     i,
			Codec:     codec,
			Language:  ext.Language,
			Title:     ext.Filename,
			Supported: isSubtitleConvertible(codec),
		})
	}

	sess = &hlsSession{
		id:           sessionID,
		url:          sourceURL,
		duration:     dur,
		audioCodec:   audio,
		subtitles:    allSubs,
		externalSubs: externals,
		lastUsed:     time.Now(),
	}
	hlsLock.Lock()
	hlsSessions[sessionID] = sess
	hlsLock.Unlock()
	log.Printf("hls: opened session %s (dur=%.1fs codec=%s subs=%d emb=%d ext=%d)",
		sessionID, dur, audio, len(allSubs), len(embedded), len(externals))
	hlsCleanupOnce.Do(startHLSCleanup)
	return sess, nil
}

// HandleStreamHLSFile — GET /api/v1/stream/hls/:sessionId/*
//
// Two paths:
//   - index.m3u8   → generate the playlist on the fly from session.duration
//   - segment_NNNNN.ts → spawn an ffmpeg that seeks to N*segDur and
//                        transcodes segDur seconds, pipes bytes back
func (h *Handler) HandleStreamHLSFile(c echo.Context) error {
	sessionID := c.Param("sessionId")
	file := c.Param("*")
	if sessionID == "" || file == "" {
		return c.NoContent(http.StatusBadRequest)
	}
	// Block path traversal.
	if strings.ContainsAny(file, "/\\") || strings.Contains(file, "..") {
		return c.NoContent(http.StatusBadRequest)
	}

	hlsLock.Lock()
	sess, ok := hlsSessions[sessionID]
	if ok {
		sess.lastUsed = time.Now()
	}
	hlsLock.Unlock()
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]any{"error": "session expired"})
	}

	switch {
	case file == "index.m3u8":
		return h.serveHLSPlaylist(c, sess)
	case strings.HasPrefix(file, "segment_") && strings.HasSuffix(file, ".ts"):
		return h.serveHLSSegment(c, sess, file)
	case strings.HasPrefix(file, "sub_") && strings.HasSuffix(file, ".vtt"):
		return h.serveHLSSubtitle(c, sess, file)
	case strings.HasPrefix(file, "ext_") && strings.HasSuffix(file, ".vtt"):
		return h.serveHLSExternalSubtitle(c, sess, file)
	}
	return c.NoContent(http.StatusNotFound)
}

// serveHLSExternalSubtitle pulls a sidecar .srt/.ass/.vtt file from
// TorBox and converts it to WebVTT on the fly. Same on-disk cache as
// the embedded path — keyed by (sessionId, "ext", idx, lang).
func (h *Handler) serveHLSExternalSubtitle(c echo.Context, sess *hlsSession, file string) error {
	numPart := strings.TrimSuffix(strings.TrimPrefix(file, "ext_"), ".vtt")
	n, err := strconv.Atoi(numPart)
	if err != nil || n < 0 || n >= len(sess.externalSubs) {
		return c.NoContent(http.StatusNotFound)
	}
	ext := sess.externalSubs[n]

	targetLang := strings.ToLower(strings.TrimSpace(c.QueryParam("translateTo")))
	if targetLang != "" && (targetLang == strings.ToLower(ext.Language) ||
		translateLangName(targetLang) == translateLangName(ext.Language)) {
		targetLang = ""
	}
	// External subs share the same disk-cache scheme — we just offset
	// the cache idx by +10_000 to avoid collisions with embedded-sub
	// entries from the same session.
	cacheIdx := n + 10_000

	if targetLang != "" {
		if cached := h.readCachedTranslation(sess.id, cacheIdx, targetLang); cached != nil {
			h.writeSubtitleResponse(c, cached, "cache:translated")
			return nil
		}
	}

	// Try the raw cache.
	raw := h.readCachedTranslation(sess.id, cacheIdx, "")
	if raw == nil {
		extracted, err := h.extractExternalSubtitleVTT(c.Request().Context(), ext.URL)
		if err != nil {
			log.Printf("hls ext sub %d: extract failed: %v", n, err)
			return c.JSON(http.StatusBadGateway, map[string]any{"error": "ffmpeg failed: " + err.Error()})
		}
		raw = extracted
		h.writeCachedTranslation(sess.id, cacheIdx, "", raw)
	}

	if targetLang == "" {
		h.writeSubtitleResponse(c, raw, "ffmpeg")
		return nil
	}
	if !h.App.Anthropic.HasKey() {
		h.writeSubtitleResponse(c, raw, "ffmpeg")
		return nil
	}
	trCtx, cancelTr := context.WithTimeout(c.Request().Context(), 5*time.Minute)
	defer cancelTr()
	translated, err := translateVTT(trCtx, h.App.Anthropic, raw, targetLang)
	if err != nil || len(translated) == 0 {
		h.writeSubtitleResponse(c, raw, "ffmpeg")
		return nil
	}
	h.writeCachedTranslation(sess.id, cacheIdx, targetLang, translated)
	h.writeSubtitleResponse(c, translated, "claude")
	return nil
}

// prewarmSessionSubtitles kicks off ffmpeg extractions for every
// supported subtitle in the session, writing results directly into the
// disk cache. Meant to run as a background goroutine straight after
// /torbox/play returns, so by the time the user opens the CC menu
// (or scrubs to a position that triggers a track load) the bytes are
// already on disk — instant response instead of a 1-3 min cold extract.
//
// Embedded subs are extracted in a SINGLE ffmpeg invocation with one
// output per track. ffmpeg reads the source file once and demuxes all
// the subtitle streams in parallel — much cheaper than N separate
// ffmpeg processes each reading the whole MKV from TorBox's CDN.
//
// External (sidecar) subs run sequentially since each has its own URL.
// They're tiny so the loop is fast.
//
// Errors are logged but never propagated — pre-warm is best-effort.
// The on-demand extraction path still works as a fallback.
func (h *Handler) prewarmSessionSubtitles(sess *hlsSession) {
	if sess == nil {
		return
	}

	// Collect embedded subs that aren't already cached. Two slices
	// instead of a struct so the helper signature stays plain.
	var cacheIdxs []int  // per-subtitles[] position, used for cache key
	var streamIdxs []int // ffmpeg's `0:s:N` index
	for i, t := range sess.subtitles {
		if t.Source != "embedded" || !t.Supported {
			continue
		}
		if h.hasCachedTranslation(sess.id, i, "") {
			continue
		}
		cacheIdxs = append(cacheIdxs, i)
		streamIdxs = append(streamIdxs, t.Index)
	}

	if len(cacheIdxs) > 0 {
		h.prewarmEmbeddedBatch(sess, cacheIdxs, streamIdxs)
	}

	// External subs — one ffmpeg per URL, sequential.
	for i, t := range sess.subtitles {
		if t.Source != "external" || !t.Supported {
			continue
		}
		cacheIdx := t.Index + 10_000
		if h.hasCachedTranslation(sess.id, cacheIdx, "") {
			continue
		}
		ext := sess.externalSubs[t.Index]
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		out, err := h.extractExternalSubtitleVTT(ctx, ext.URL)
		cancel()
		if err != nil {
			log.Printf("hls prewarm: external sub %d (%s) failed: %v", i, ext.Filename, err)
			continue
		}
		h.writeCachedTranslation(sess.id, cacheIdx, "", out)
	}
}

// prewarmEmbeddedBatch runs ONE ffmpeg invocation with multiple
// outputs to extract every supplied subtitle track in a single pass
// over the source file.
//
// Layout: `ffmpeg -i <src> -map 0:s:0 -c:s webvtt -f webvtt out0.tmp
//                          -map 0:s:1 -c:s webvtt -f webvtt out1.tmp ...`
// Each output's args (everything between two outputs) apply only to
// that output. ffmpeg demuxes the source ONCE.
func (h *Handler) prewarmEmbeddedBatch(sess *hlsSession, cacheIdxs, streamIdxs []int) {
	if len(cacheIdxs) == 0 || len(cacheIdxs) != len(streamIdxs) {
		return
	}
	cacheDir := filepath.Dir(h.translateSubtitleCachePath(sess.id, 0, ""))
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		log.Printf("hls prewarm: mkdir cache dir: %v", err)
		return
	}

	args := []string{
		"-hide_banner",
		"-loglevel", "warning",
		"-i", sess.url,
	}
	tmpPaths := make([]string, 0, len(cacheIdxs))
	finalPaths := make([]string, 0, len(cacheIdxs))
	for i, ci := range cacheIdxs {
		final := h.translateSubtitleCachePath(sess.id, ci, "")
		tmp := final + ".tmp"
		finalPaths = append(finalPaths, final)
		tmpPaths = append(tmpPaths, tmp)
		args = append(args,
			"-map", fmt.Sprintf("0:s:%d", streamIdxs[i]),
			"-c:s", "webvtt",
			"-f", "webvtt",
			"-y", // overwrite tmp from a previous crash
			tmp,
		)
	}

	log.Printf("hls prewarm: batch extracting %d embedded subs for session %s",
		len(cacheIdxs), sess.id)
	start := time.Now()

	// 10 min covers a feature-length anime over a slow CDN. ffmpeg
	// only reads the source once but still has to find the last
	// subtitle event for each track, which means reading near the
	// end of the file.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err := cmd.Run()
	dur := time.Since(start)

	if err != nil {
		log.Printf("hls prewarm: ffmpeg failed after %s: %v | %s",
			dur, err, strings.TrimSpace(stderr.String()))
		// Clean up the .tmp files; the on-demand path will retry.
		for _, p := range tmpPaths {
			_ = os.Remove(p)
		}
		return
	}

	// Promote .tmp → final atomically per file.
	ok := 0
	for i, tmp := range tmpPaths {
		info, statErr := os.Stat(tmp)
		if statErr != nil || info.Size() == 0 {
			_ = os.Remove(tmp)
			continue
		}
		if err := os.Rename(tmp, finalPaths[i]); err == nil {
			ok++
		}
	}
	log.Printf("hls prewarm: batch done in %s, %d/%d subs cached",
		dur, ok, len(cacheIdxs))
}

// extractExternalSubtitleVTT converts a sidecar subtitle file (HTTP
// URL — TorBox direct download) to WebVTT. Files are small (a few KB
// to ~1 MB) so a 60 s timeout is generous.
func (h *Handler) extractExternalSubtitleVTT(parent context.Context, sourceURL string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "warning",
		"-i", sourceURL,
		"-c:s", "webvtt",
		"-f", "webvtt",
		"pipe:1",
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%v | %s", err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// serveHLSSubtitle extracts a single subtitle stream from the source via
// ffmpeg and converts it to WebVTT on the fly. ffmpeg has to read a
// chunk of the (remote) MKV to extract a single track, so the first
// fetch can take 1-3 min on a feature-length episode. Subsequent
// fetches hit the on-disk cache and return in milliseconds.
//
// URL shape: /api/v1/stream/hls/<sessionId>/sub_<idx>.vtt[?translateTo=fr]
//   idx          — position in session.subtitles, NOT the absolute
//                  stream index in the source file.
//   translateTo  — when present + Anthropic key is configured, the
//                  extracted VTT is run through Claude to translate
//                  dialogue lines into the target language.
//
// Two caches:
//   1. Raw extracted VTT          — keyed by (sessionId, idx, "")
//   2. Translated VTT             — keyed by (sessionId, idx, targetLang)
// Cache (2) only exists when targetLang != "". Cache (1) makes repeated
// /sub_N.vtt fetches instant + provides the source for cache (2) without
// re-extracting.
func (h *Handler) serveHLSSubtitle(c echo.Context, sess *hlsSession, file string) error {
	numPart := strings.TrimSuffix(strings.TrimPrefix(file, "sub_"), ".vtt")
	n, err := strconv.Atoi(numPart)
	if err != nil || n < 0 || n >= len(sess.subtitles) {
		return c.NoContent(http.StatusNotFound)
	}
	track := sess.subtitles[n]
	if !track.Supported {
		return c.JSON(http.StatusUnprocessableEntity, map[string]any{
			"error": "subtitle codec not convertible to webvtt: " + track.Codec,
		})
	}

	targetLang := strings.ToLower(strings.TrimSpace(c.QueryParam("translateTo")))
	if targetLang != "" && (targetLang == strings.ToLower(track.Language) ||
		translateLangName(targetLang) == translateLangName(track.Language)) {
		targetLang = ""
	}

	// Cache lookup — translated VTT (fast path when the user is on a
	// previously-translated episode).
	if targetLang != "" {
		if cached := h.readCachedTranslation(sess.id, n, targetLang); cached != nil {
			h.writeSubtitleResponse(c, cached, "cache:translated")
			return nil
		}
	}

	// Try the RAW extraction cache. Lets us skip the ffmpeg call
	// entirely when this track has been served before in the same
	// session (or a previous session with the same source URL — the
	// session id hashes the URL).
	raw := h.readCachedTranslation(sess.id, n, "")
	if raw == nil {
		extracted, err := h.extractSubtitleVTT(c.Request().Context(), sess.url, track.Index)
		if err != nil {
			log.Printf("hls sub %d: extract failed: %v", n, err)
			return c.JSON(http.StatusBadGateway, map[string]any{"error": "ffmpeg failed: " + err.Error()})
		}
		raw = extracted
		h.writeCachedTranslation(sess.id, n, "", raw)
	}

	// No translation requested — serve the raw VTT.
	if targetLang == "" {
		h.writeSubtitleResponse(c, raw, "ffmpeg")
		return nil
	}

	// Translation path. If Claude isn't configured, fall back to the
	// raw extraction (better than a 500).
	if !h.App.Anthropic.HasKey() {
		h.writeSubtitleResponse(c, raw, "ffmpeg")
		return nil
	}
	trCtx, cancelTr := context.WithTimeout(c.Request().Context(), 5*time.Minute)
	defer cancelTr()
	translated, err := translateVTT(trCtx, h.App.Anthropic, raw, targetLang)
	if err != nil || len(translated) == 0 {
		log.Printf("hls sub %d: translation failed, serving original: %v", n, err)
		h.writeSubtitleResponse(c, raw, "ffmpeg")
		return nil
	}
	h.writeCachedTranslation(sess.id, n, targetLang, translated)
	h.writeSubtitleResponse(c, translated, "claude")
	return nil
}

// extractSubtitleVTT runs ffmpeg against the source URL to pull subtitle
// stream `streamIdx` and convert it to WebVTT. -vn -an explicitly skips
// the video + audio streams so ffmpeg's demuxer doesn't try to keep
// buffering them while only the subtitle bytes are needed.
//
// Long timeout (5 min) because ffmpeg has to skim the whole remote MKV
// to find every subtitle event for the requested track. The first
// extraction is the slow one; the disk cache eats subsequent fetches.
func (h *Handler) extractSubtitleVTT(parent context.Context, sourceURL string, streamIdx int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "warning",
		"-vn",
		"-an",
		"-i", sourceURL,
		"-map", fmt.Sprintf("0:s:%d", streamIdx),
		"-c:s", "webvtt",
		"-f", "webvtt",
		"pipe:1",
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%v | %s", err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

func (h *Handler) writeSubtitleResponse(c echo.Context, body []byte, source string) {
	c.Response().Header().Set("Content-Type", "text/vtt; charset=utf-8")
	c.Response().Header().Set("Cache-Control", "public, max-age=86400")
	c.Response().Header().Set("X-Translation-Source", source)
	c.Response().WriteHeader(http.StatusOK)
	_, _ = c.Response().Writer.Write(body)
}

// serveHLSPlaylist generates a VOD-typed m3u8 listing every segment from
// 0 to ceil(duration / segDur). EXT-X-ENDLIST tells the player the file
// is finite — that's what makes the progress bar show the full length
// from the first frame.
func (h *Handler) serveHLSPlaylist(c echo.Context, sess *hlsSession) error {
	segCount := int(math.Ceil(sess.duration / hlsSegDurSec))
	if segCount < 1 {
		segCount = 1
	}

	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	b.WriteString("#EXT-X-VERSION:3\n")
	fmt.Fprintf(&b, "#EXT-X-TARGETDURATION:%d\n", int(math.Ceil(hlsSegDurSec)))
	b.WriteString("#EXT-X-PLAYLIST-TYPE:VOD\n")
	b.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n")

	for i := 0; i < segCount; i++ {
		segDur := hlsSegDurSec
		if i == segCount-1 {
			// Final segment is the remainder.
			segDur = sess.duration - float64(i)*hlsSegDurSec
			if segDur <= 0 || segDur > hlsSegDurSec {
				segDur = hlsSegDurSec
			}
		}
		fmt.Fprintf(&b, "#EXTINF:%.3f,\n", segDur)
		fmt.Fprintf(&b, "segment_%05d.ts\n", i)
	}
	b.WriteString("#EXT-X-ENDLIST\n")

	c.Response().Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.String(http.StatusOK, b.String())
}

// serveHLSSegment spawns a per-request ffmpeg that seeks to the start of
// the requested segment and transcodes just segDur worth. `-c:v copy`
// keeps video quality intact; audio is re-encoded to AAC stereo.
//
// `-ss before -i` is the fast (input) seek — keyframe-accurate, can
// drift by up to one GOP but cheap. For HLS that's fine, the next
// segment overlaps anyway.
func (h *Handler) serveHLSSegment(c echo.Context, sess *hlsSession, file string) error {
	// Parse segment number out of "segment_NNNNN.ts".
	numPart := strings.TrimSuffix(strings.TrimPrefix(file, "segment_"), ".ts")
	n, err := strconv.Atoi(numPart)
	if err != nil || n < 0 {
		return c.NoContent(http.StatusBadRequest)
	}
	startSec := float64(n) * hlsSegDurSec
	if startSec >= sess.duration {
		return c.NoContent(http.StatusNotFound)
	}
	segDur := hlsSegDurSec
	if startSec+segDur > sess.duration {
		segDur = sess.duration - startSec
	}

	ctx := c.Request().Context()
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "warning",
		"-ss", fmt.Sprintf("%.3f", startSec),
		"-i", sess.url,
		"-t", fmt.Sprintf("%.3f", segDur),
		"-c:v", "copy",
		"-c:a", "aac",
		"-b:a", "192k",
		"-ac", "2",
		// Continuous timestamps across segments — important for the
		// player to stitch chunks without gaps / clock jumps.
		"-output_ts_offset", fmt.Sprintf("%.3f", startSec),
		"-mpegts_copyts", "1",
		"-f", "mpegts",
		"pipe:1",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return RespondErr(c, err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{
			"error": "ffmpeg start: " + err.Error(),
		})
	}

	c.Response().Header().Set("Content-Type", "video/mp2t")
	c.Response().Header().Set("Cache-Control", "public, max-age=3600")
	c.Response().WriteHeader(http.StatusOK)
	_, _ = io.Copy(c.Response().Writer, stdout)
	if werr := cmd.Wait(); werr != nil {
		log.Printf("hls seg %d: ffmpeg %v | %s", n, werr, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// probeMediaInfo runs ffprobe once to extract the duration and the
// first audio stream codec. Returns (duration, "") on success,
// (0, "") on failure. Kept as a tiny shim around probeMediaFull for
// callers that only need the duration/audio pair.
func probeMediaInfo(parent context.Context, url string) (float64, string) {
	dur, audio, _ := probeMediaFull(parent, url)
	return dur, audio
}

// probeMediaFull runs a single ffprobe invocation that returns the
// duration, the first audio stream's codec, and every subtitle stream
// in the source (with language + codec metadata).
//
// One probe is preferable to two because TorBox's CDN sometimes
// rate-limits / 403s on rapid repeats, and ffprobe-over-network is the
// expensive part of the cold-play path (≈ 1-2 s).
//
// Subtitle indices are 0-based among the subtitle streams themselves,
// not the global stream index — what we hand to `-map 0:s:N` later.
//
// Parser note: ffprobe's "default" output groups attributes per stream
// in declaration order. A subtitle stream block looks like:
//
//     codec_name=ass
//     codec_type=subtitle
//     TAG:language=fre
//     TAG:title=Forced
//
// The language + title tags come AFTER codec_type, so we can't flush
// the stream on codec_type — we'd record an empty language. Instead we
// accumulate attributes until the NEXT codec_name= (or EOF) and flush
// the previous stream then. This caught us out on JJK VOSTFR releases
// where every subtitle landed with Language="" and the player picked
// none of them as preferred.
func probeMediaFull(parent context.Context, url string) (float64, string, []SubtitleTrack) {
	ctx, cancel := context.WithTimeout(parent, 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		// Scan deeper than the default 5s/5MB. MKV stream metadata
		// usually lives in the EBML header so this is fast, but some
		// releases (esp. anime with many subtitle tracks) keep the
		// secondary tracks farther back in the file. 200MB / 60s
		// covers everything we've seen in the wild.
		"-analyzeduration", "60M",
		"-probesize", "200M",
		"-show_entries", "format=duration:stream=codec_name,codec_type:stream_tags=language,title",
		"-of", "default=noprint_wrappers=1",
		url,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		log.Printf("ffprobe FAIL: %v | %s", err, strings.TrimSpace(stderr.String()))
		return 0, "", nil
	}

	var (
		dur      float64
		audio    string
		subs     []SubtitleTrack
		subIdx   int
		curName  string
		curType  string
		curLang  string
		curTitle string
	)
	flush := func() {
		switch curType {
		case "audio":
			if audio == "" {
				audio = strings.ToLower(curName)
			}
		case "subtitle":
			subs = append(subs, SubtitleTrack{
				Index:     subIdx,
				Codec:     strings.ToLower(curName),
				Language:  curLang,
				Title:     curTitle,
				Supported: isSubtitleConvertible(curName),
			})
			subIdx++
		}
		curName, curType, curLang, curTitle = "", "", "", ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "duration="):
			v, _ := strconv.ParseFloat(strings.TrimPrefix(line, "duration="), 64)
			if v > 0 {
				dur = v
			}
		case strings.HasPrefix(line, "codec_name="):
			// Start of a new stream block — flush the previous one.
			flush()
			curName = strings.TrimPrefix(line, "codec_name=")
		case strings.HasPrefix(line, "codec_type="):
			curType = strings.TrimPrefix(line, "codec_type=")
		case strings.HasPrefix(line, "TAG:language="):
			curLang = strings.ToLower(strings.TrimPrefix(line, "TAG:language="))
		case strings.HasPrefix(line, "TAG:title="):
			curTitle = strings.TrimPrefix(line, "TAG:title=")
		}
	}
	// Final stream — no more codec_name= lines to trigger a flush.
	flush()

	if len(subs) > 0 {
		summary := make([]string, 0, len(subs))
		for _, s := range subs {
			summary = append(summary, fmt.Sprintf("%s/%s", s.Codec, s.Language))
		}
		log.Printf("ffprobe OK: duration=%.1fs audio=%q subs=%d [%s]",
			dur, audio, len(subs), strings.Join(summary, ", "))
	} else {
		log.Printf("ffprobe OK: duration=%.1fs audio=%q subs=0", dur, audio)
		// Dump the raw stdout so the operator can see what ffprobe
		// actually said. If subs really are 0 the dump shows only
		// video + audio streams; if there's a parser miss it shows
		// subtitle blocks we failed to capture.
		log.Printf("ffprobe RAW:\n%s", strings.TrimRight(string(out), "\n"))
	}
	return dur, audio, subs
}

// isSubtitleConvertible reports whether ffmpeg can turn this codec into
// WebVTT. Text-based formats (ASS, SRT, mov_text, WebVTT itself) are
// fine; graphical formats (PGS, VobSub) need an OCR step we don't
// implement, so we mark them unsupported and the frontend disables the
// corresponding <track>.
func isSubtitleConvertible(codec string) bool {
	switch strings.ToLower(codec) {
	case "subrip", "srt",
		"ass", "ssa",
		"webvtt", "vtt",
		"mov_text",
		"text", "subviewer":
		return true
	}
	return false
}

// startHLSCleanup reaps sessions idle for more than 15 min. No temp
// files to remove anymore — sessions are pure metadata.
func startHLSCleanup() {
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			hlsLock.Lock()
			now := time.Now()
			for id, sess := range hlsSessions {
				if now.Sub(sess.lastUsed) > 15*time.Minute {
					log.Printf("hls: reaping idle session %s", id)
					delete(hlsSessions, id)
				}
			}
			hlsLock.Unlock()
		}
	}()
}
