package handlers

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
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

// Number of source-variant chunks to prebake in the background when an
// HLS session opens. 10 × 4s = 40s of playback buffered to disk before
// the user clicks Play → instant cold-start (sub-second from <video>
// mount to first frame) AND a comfortable cushion against early
// rebuffer while the player ramps up its own download.
const hlsPrebakeChunkCount = 10

// How many prebake ffmpeg processes may hit TorBox in parallel.
// 4 is the empirical sweet spot: TorBox's CDN handles parallel range
// requests fine, but pushing higher hits the per-IP rate limiter and
// the gains plateau anyway because individual chunks are CDN-bound.
const hlsPrebakeConcurrency = 4

// ffmpegHTTPInputFlags returns input-side options that make ffmpeg's
// HTTP demuxer resilient against transient TorBox CDN hiccups
// (TCP RST, brief 5xx, slow first byte, idle TLS connection drop).
// MUST be inserted BEFORE the `-i URL` argument on the command line —
// these are input options, not output options.
//
// Only safe flags for ffmpeg ≥ 4.4 are used; earlier attempts at
// `-reconnect_on_network_error` / `-reconnect_on_http_error` /
// `-reconnect_at_eof` crashed the user's build with "option not found".
func ffmpegHTTPInputFlags() []string {
	return []string{
		"-multiple_requests", "1", // HTTP/1.1 keep-alive across range requests
		"-seekable", "1",
		"-reconnect", "1",
		"-reconnect_streamed", "1",
		"-reconnect_delay_max", "5",
		"-rw_timeout", "30000000", // 30 s in microseconds — kills hung sockets
	}
}

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

	// Subtitle-prep state — populated when the frontend POSTs to
	// /prep. The watch page polls the GET counterpart to render a
	// progress bar before transitioning to actual playback.
	prepMu sync.Mutex
	prep   SubPrepStatus
}

// SubPrepStatus is what the watch page polls to drive its
// "Préparation des sous-titres" overlay.
type SubPrepStatus struct {
	// State machine:
	//   idle         — no prep requested yet (or lang was "off")
	//   picking      — backend deciding which native track to use
	//   extracting   — ffmpeg pulling the chosen sub from the source
	//   translating  — Claude rewriting cues into the target language
	//   ready        — cache file written, frontend can start playback
	//   failed       — see Error for the reason
	State string `json:"state"`
	// 0-100 with two decimals of precision. During extraction it's the
	// real ffmpeg-reported position (out_time_ms / source duration);
	// during translation it's batch progress mapped into 50-95%.
	Progress float64 `json:"progress"`
	// Index into session.subtitles of the source we picked. -1 when
	// no suitable source was available.
	ChosenSubIdx int `json:"chosenSubIdx"`
	// Language tag of the chosen source (ISO-639 from ffprobe).
	ChosenLang string `json:"chosenLang"`
	// True when ChosenLang != requested → Claude is invoked.
	WillTranslate bool   `json:"willTranslate"`
	TargetLang    string `json:"targetLang"`
	Error         string `json:"error,omitempty"`
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

	// Capture the data dir for the chunk-cache reaper. Once-per-process.
	hlsCleanupDataDir = h.App.Config.Data.Dir
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
	case strings.HasPrefix(file, "playlist_") && strings.HasSuffix(file, ".m3u8"):
		variant := strings.TrimSuffix(strings.TrimPrefix(file, "playlist_"), ".m3u8")
		return h.serveHLSVariantPlaylist(c, sess, variant)
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

// pickSubtitleForLang chooses ONE subtitle source for the user's
// preferred language, prioritising in this order:
//
//   1. A native track in the preferred language (best — no translation).
//   2. A native track in English (good source for Claude → target).
//   3. A native track in Japanese (anime fallback).
//   4. The first supported track of any language.
//
// Returns -1 when no supported subtitle exists in the session. The
// boolean reports whether Claude translation is needed.
func pickSubtitleForLang(subs []SubtitleTrack, prefLang string) (chosenIdx int, willTranslate bool) {
	if prefLang == "" || prefLang == "off" {
		return -1, false
	}
	if prefLang == "auto" {
		prefLang = "fr"
	}

	matches := func(track SubtitleTrack, wantCode string) bool {
		if !track.Supported {
			return false
		}
		return languageMatches(track.Language, wantCode)
	}

	// 1. Preferred lang native.
	for i, t := range subs {
		if matches(t, prefLang) {
			return i, false
		}
	}
	// 2. English (translated).
	for i, t := range subs {
		if matches(t, "en") {
			return i, true
		}
	}
	// 3. Japanese (translated).
	for i, t := range subs {
		if matches(t, "ja") {
			return i, true
		}
	}
	// 4. First supported, any language (translated).
	for i, t := range subs {
		if t.Supported {
			return i, true
		}
	}
	return -1, false
}

// languageMatches compares an ffprobe language tag (often ISO-639-2
// like "fre") against a BCP-47 user code (typically 2-letter "fr").
// Both directions tolerated; lowercase, normalised.
func languageMatches(probe, wantCode string) bool {
	probe = strings.ToLower(probe)
	wantCode = strings.ToLower(wantCode)
	if probe == "" || wantCode == "" {
		return false
	}
	if probe == wantCode {
		return true
	}
	// Map 2-letter to 3-letter and vice versa via translateLangName's
	// "English name" round-trip — if both reduce to the same name,
	// they're the same language.
	if translateLangName(probe) == translateLangName(wantCode) {
		return true
	}
	return false
}

// startSubPrep is the entry point for the "prepare a single sub before
// playback" flow. Idempotent: re-calling on the same session+lang
// returns the existing status instead of restarting.
//
// Spawns a background goroutine that updates session.prep as it
// progresses. Frontend polls via HandleSubPrepStatus.
func (h *Handler) startSubPrep(sess *hlsSession, prefLang string) SubPrepStatus {
	sess.prepMu.Lock()
	current := sess.prep
	// If a prep is already in flight or done for THIS language, return
	// its current status. "lang=off" is also a fast-path no-op.
	if prefLang == "" || prefLang == "off" {
		sess.prep = SubPrepStatus{State: "ready", Progress: 100, ChosenSubIdx: -1, TargetLang: prefLang}
		out := sess.prep
		sess.prepMu.Unlock()
		return out
	}
	if current.State == "ready" && current.TargetLang == prefLang {
		sess.prepMu.Unlock()
		return current
	}
	if (current.State == "extracting" || current.State == "translating") && current.TargetLang == prefLang {
		sess.prepMu.Unlock()
		return current
	}

	chosenIdx, willTranslate := pickSubtitleForLang(sess.subtitles, prefLang)
	if chosenIdx < 0 {
		// No suitable source — mark ready (with no track) so the
		// frontend doesn't hang waiting.
		sess.prep = SubPrepStatus{State: "ready", Progress: 100, ChosenSubIdx: -1, TargetLang: prefLang}
		out := sess.prep
		sess.prepMu.Unlock()
		return out
	}
	chosen := sess.subtitles[chosenIdx]
	sess.prep = SubPrepStatus{
		State:         "picking",
		Progress:      5,
		ChosenSubIdx:  chosenIdx,
		ChosenLang:    chosen.Language,
		TargetLang:    prefLang,
		WillTranslate: willTranslate,
	}
	out := sess.prep
	sess.prepMu.Unlock()

	go h.runSubPrep(sess, chosenIdx, prefLang, willTranslate)
	return out
}

// runSubPrep drives the prep state machine: picking → extracting →
// (optionally) translating → ready.
func (h *Handler) runSubPrep(sess *hlsSession, chosenIdx int, targetLang string, willTranslate bool) {
	setState := func(state string, progress float64, errMsg string) {
		sess.prepMu.Lock()
		sess.prep.State = state
		sess.prep.Progress = progress
		if errMsg != "" {
			sess.prep.Error = errMsg
		}
		sess.prepMu.Unlock()
	}

	track := sess.subtitles[chosenIdx]

	// Step 1: Extract raw VTT (unless already cached).
	rawCacheIdx := chosenIdx
	if track.Source == "external" {
		rawCacheIdx = track.Index + 10_000
	}

	// Extraction occupies 0-50% of the bar. Translation (when needed)
	// fills 50-95%; the final state=ready sets 100.
	const extractMax = 50.0
	const translateMin = 50.0
	const translateMax = 95.0

	var raw []byte
	if cached := h.readCachedTranslation(sess.id, rawCacheIdx, ""); cached != nil {
		raw = cached
		setState("extracting", extractMax, "")
	} else {
		// Phase A: parallel-download the source to local disk (0-45%).
		// Phase B: ffmpeg-extract from the local file (45-50%).
		//
		// This replaces the previous "ffmpeg over HTTP" path which was
		// bandwidth-bound by a single TCP connection (2-3 min on
		// TorBox). Eight concurrent range requests saturate the LAN
		// pipe and bring the same download to 15-45 s; the local
		// ffmpeg extract that follows is disk-speed (~2-5 s).
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		setState("extracting", 1, "")

		var (
			out      []byte
			err      error
			progMu   sync.Mutex
			progress float64
		)
		applyProgress := func(p float64) {
			progMu.Lock()
			if p > progress {
				progress = p
			}
			combined := progress
			progMu.Unlock()
			scaled := combined * extractMax / 100
			if scaled > extractMax {
				scaled = extractMax
			}
			setState("extracting", scaled, "")
		}

		if track.Source == "external" {
			// Sidecar files are tiny (KB-MB) — ffmpeg-over-HTTP completes
			// in seconds.
			ext := sess.externalSubs[track.Index]
			out, err = h.extractExternalSubtitleVTT(ctx, ext.URL)
		} else {
			// Pure-stream path: ffmpeg reads embedded subs straight from
			// the TorBox HTTP URL — no local source cache. The translated
			// VTT output is the only thing we persist.
			out, err = h.extractEmbeddedSubtitleWithProgress(ctx, sess.url, track.Index, sess.duration, func(pct float64) {
				applyProgress(pct * 0.95)
			})
		}
		cancel()
		if err != nil || len(out) == 0 {
			log.Printf("hls prep: extract failed for session %s (track %d, lang %q): %v",
				sess.id, track.Index, track.Language, err)
			msg := "extraction failed"
			if err != nil {
				msg = err.Error()
				if len(msg) > 200 {
					msg = msg[:200] + "…"
				}
			}
			setState("failed", 0, msg)
			return
		}
		h.writeCachedTranslation(sess.id, rawCacheIdx, "", out)
		raw = out
		setState("extracting", extractMax, "")
	}

	// Step 2: Translation (only when needed).
	if !willTranslate {
		setState("ready", 100, "")
		log.Printf("hls prep: session %s ready (native %s)", sess.id, track.Language)
		return
	}

	// Already translated and cached?
	if cached := h.readCachedTranslation(sess.id, rawCacheIdx, targetLang); cached != nil {
		setState("ready", 100, "")
		log.Printf("hls prep: session %s ready (cached translation %s→%s)",
			sess.id, track.Language, targetLang)
		return
	}

	if !h.App.Anthropic.HasKey() {
		setState("ready", 100, "no anthropic key — serving native subs")
		log.Printf("hls prep: session %s ready (no claude key, serving %s)",
			sess.id, track.Language)
		return
	}

	setState("translating", translateMin, "")
	trCtx, cancelTr := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancelTr()
	progressCb := func(done, total int) {
		if total == 0 {
			return
		}
		p := translateMin + float64(done)*(translateMax-translateMin)/float64(total)
		if p > translateMax {
			p = translateMax
		}
		setState("translating", p, "")
	}
	translated, err := translateVTTWithProgress(trCtx, h.App.Anthropic, raw, targetLang, progressCb)
	if err != nil || len(translated) == 0 {
		log.Printf("hls prep: translation failed: %v", err)
		setState("ready", 100, fmt.Sprintf("translation failed: %v — serving native", err))
		return
	}
	h.writeCachedTranslation(sess.id, rawCacheIdx, targetLang, translated)
	setState("ready", 100, "")
	log.Printf("hls prep: session %s ready (claude %s→%s)",
		sess.id, track.Language, targetLang)
}

// extractEmbeddedSubtitleWithProgress runs ffmpeg with `-progress pipe:2`
// so progress can be reported in real time. ffmpeg writes K=V lines to
// stderr like:
//
//   out_time_us=12345678
//   out_time_ms=12345678
//   out_time=00:00:12.345
//   progress=continue        // or "end" on the final block
//
// For subtitle output, out_time_ms tracks the timestamp of the latest
// cue emitted, so progress = (out_time / duration_seconds) is a real
// readout of where ffmpeg is inside the source file.
//
// duration is the source media duration in seconds (from ffprobe); when
// 0 we still report 0-100 in some indeterminate way — the caller can
// still see "ffmpeg is running" via the state field.
func (h *Handler) extractEmbeddedSubtitleWithProgress(
	parent context.Context,
	sourceURL string,
	streamIdx int,
	duration float64,
	progressCb func(pct float64),
) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()

	subArgs := []string{
		"-hide_banner",
		"-loglevel", "error",
		// -progress writes K=V progress info to fd 2 (stderr). With
		// -loglevel error nothing else writes there, so the scanner
		// only sees progress lines and actual error messages — both
		// of which we collect.
		"-progress", "pipe:2",
	}
	subArgs = append(subArgs, ffmpegHTTPInputFlags()...)
	subArgs = append(subArgs,
		// Cap the format-probe scan since /torbox/play already
		// ffprobed the source.
		"-analyzeduration", "5M",
		"-probesize", "10M",
		"-i", sourceURL,
		"-map", fmt.Sprintf("0:s:%d", streamIdx),
		"-c:s", "webvtt",
		"-f", "webvtt",
		"pipe:1",
	)
	cmd := exec.CommandContext(ctx, "ffmpeg", subArgs...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	// Read stderr in a background goroutine: route `out_time_ms=` lines
	// to the progress callback, accumulate everything else as an error
	// buffer (so failure messages survive to the caller).
	var stderrMu sync.Mutex
	var stderrBuf strings.Builder
	go func() {
		buf := bufio.NewScanner(stderr)
		for buf.Scan() {
			line := buf.Text()
			if strings.HasPrefix(line, "out_time_ms=") && progressCb != nil {
				msStr := strings.TrimPrefix(line, "out_time_ms=")
				ms, perr := strconv.ParseFloat(strings.TrimSpace(msStr), 64)
				if perr == nil && duration > 0 {
					sec := ms / 1_000_000
					pct := sec / duration * 100
					if pct < 0 {
						pct = 0
					}
					if pct > 100 {
						pct = 100
					}
					progressCb(pct)
				}
				continue
			}
			// Skip the structured progress keys that aren't useful
			// here (fps=, bitrate=, total_size=, …) — they'd swamp
			// the error buffer otherwise.
			if strings.ContainsRune(line, '=') {
				continue
			}
			stderrMu.Lock()
			stderrBuf.WriteString(line)
			stderrBuf.WriteByte('\n')
			stderrMu.Unlock()
		}
	}()

	out, readErr := io.ReadAll(stdout)
	waitErr := cmd.Wait()

	stderrMu.Lock()
	stderrMsg := strings.TrimSpace(stderrBuf.String())
	stderrMu.Unlock()

	if waitErr != nil {
		// Surface BOTH the exit code AND whatever ffmpeg printed.
		// Previously we returned just the exit code, which made
		// "ffmpeg signal: killed" or "exit status 1" the only
		// thing visible — no idea WHY it failed.
		if stderrMsg != "" {
			return nil, fmt.Errorf("ffmpeg: %v — %s", waitErr, stderrMsg)
		}
		return nil, fmt.Errorf("ffmpeg: %v", waitErr)
	}
	if readErr != nil {
		return nil, readErr
	}
	if len(out) == 0 && stderrMsg != "" {
		return nil, fmt.Errorf("ffmpeg produced no output: %s", stderrMsg)
	}
	return out, nil
}


// HandleSubPrepStart — POST /api/v1/stream/hls/:sessionId/prep
// Body: {"lang": "fr"}
// Returns the current SubPrepStatus (which may have just been kicked
// off, or already in flight, or already ready).
func (h *Handler) HandleSubPrepStart(c echo.Context) error {
	sessionID := c.Param("sessionId")
	hlsLock.Lock()
	sess, ok := hlsSessions[sessionID]
	if ok {
		sess.lastUsed = time.Now()
	}
	hlsLock.Unlock()
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]any{"error": "session expired"})
	}
	var body struct {
		Lang string `json:"lang"`
	}
	_ = c.Bind(&body)
	status := h.startSubPrep(sess, body.Lang)
	return RespondOK(c, status)
}

// HandleSubPrepStatus — GET /api/v1/stream/hls/:sessionId/prep
// Returns the current state of the prep machinery. Polled by the
// watch page every ~1 s to drive the progress bar.
func (h *Handler) HandleSubPrepStatus(c echo.Context) error {
	sessionID := c.Param("sessionId")
	hlsLock.Lock()
	sess, ok := hlsSessions[sessionID]
	if ok {
		sess.lastUsed = time.Now()
	}
	hlsLock.Unlock()
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]any{"error": "session expired"})
	}
	sess.prepMu.Lock()
	status := sess.prep
	sess.prepMu.Unlock()
	return RespondOK(c, status)
}

// extractExternalSubtitleVTT converts a sidecar subtitle file (HTTP
// URL — TorBox direct download) to WebVTT. Files are small (a few KB
// to ~1 MB) so a 60 s timeout is generous.
func (h *Handler) extractExternalSubtitleVTT(parent context.Context, sourceURL string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	args := []string{
		"-hide_banner",
		"-loglevel", "warning",
	}
	args = append(args, ffmpegHTTPInputFlags()...)
	args = append(args,
		"-i", sourceURL,
		"-c:s", "webvtt",
		"-f", "webvtt",
		"pipe:1",
	)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
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

// HLS variants for adaptive bitrate. The "source" variant is `-c copy`
// (whatever the original file uses) and is fastest to bake but heaviest
// on bandwidth. The "720p" variant re-encodes to a 720p H.264 + AAC
// stream around 2 Mbps — much friendlier to cellular / WAN clients.
// hls.js's ABR algorithm switches between them based on real-time
// bandwidth measurements.
type hlsVariant struct {
	Name      string // always "source" — kept as a struct for the chunk-path helper
	Bandwidth int    // declared bitrate for the master playlist
	Width     int    // pixel width for the master playlist
	Height    int    // pixel height
	Scale     string // empty (we never scale — pure codec-copy)
	VideoArgs []string // ffmpeg video codec args ("-c:v copy")
	VideoBR   string   // unused, kept for shape
}

// hlsVariants returns the single source variant. We don't ABR-ladder
// any more: re-encoding to 720p/480p/360p over a remote HTTP source
// would either be cripplingly slow per chunk or require a local file
// cache — both rejected by the user (pure-stream mode, nothing on
// disk except ephemeral chunks). hls.js gracefully accepts a master
// playlist with a single variant.
func hlsVariants() []hlsVariant {
	return []hlsVariant{
		{
			Name:      "source",
			Bandwidth: 8_000_000,
			Width:     1920,
			Height:    1080,
			VideoArgs: []string{"-c:v", "copy"},
		},
	}
}

// hlsChunkCacheVariantPath is hlsChunkCachePath with a variant subdir
// so the source-quality .ts files don't collide with 720p .ts files
// for the same chunk index.
func (h *Handler) hlsChunkCacheVariantPath(sessionID, variant string, n int) string {
	return filepath.Join(h.App.Config.Data.Dir, "cache", "hls-chunks",
		sessionID, variant, fmt.Sprintf("%05d.ts", n))
}

// serveHLSPlaylist returns the master playlist. Currently a single
// `source` variant — no ABR ladder (see hlsVariants).
func (h *Handler) serveHLSPlaylist(c echo.Context, sess *hlsSession) error {
	var b strings.Builder
	b.WriteString("#EXTM3U\n")
	b.WriteString("#EXT-X-VERSION:3\n")
	for _, v := range hlsVariants() {
		// Hint a generic H.264 High @ 4.0 + AAC-LC. We're codec-copying,
		// so the real codec inside the .ts is whatever the source had;
		// hls.js uses this only as an ABR hint, not for strict decode
		// validation.
		codecs := "avc1.640028,mp4a.40.2"
		fmt.Fprintf(&b,
			"#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s\"\n",
			v.Bandwidth, v.Width, v.Height, codecs)
		fmt.Fprintf(&b, "playlist_%s.m3u8\n", v.Name)
	}

	c.Response().Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.String(http.StatusOK, b.String())
}

// serveHLSVariantPlaylist returns the per-level playlist for one ABR
// variant. Each variant has its own chunk URL prefix so the chunks
// don't collide on disk.
func (h *Handler) serveHLSVariantPlaylist(c echo.Context, sess *hlsSession, variant string) error {
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
			segDur = sess.duration - float64(i)*hlsSegDurSec
			if segDur <= 0 || segDur > hlsSegDurSec {
				segDur = hlsSegDurSec
			}
		}
		fmt.Fprintf(&b, "#EXTINF:%.3f,\n", segDur)
		fmt.Fprintf(&b, "segment_%s_%05d.ts\n", variant, i)
	}
	b.WriteString("#EXT-X-ENDLIST\n")

	c.Response().Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.String(http.StatusOK, b.String())
}


// serveHLSSegment serves the requested HLS .ts chunk. Two paths:
//
//  1. Cache hit — chunk already prebaked or generated by a previous
//     request → serve from disk, < 100 ms.
//  2. Cache miss — spawn ffmpeg, transcode the segment, write to disk
//     AND pipe back to the browser. Subsequent requests for the same
//     chunk (seek-back, re-watch) hit case 1.
//
// `-c:v copy` keeps video quality intact; audio is re-encoded to AAC
// stereo. `-ss before -i` is the fast (input) seek — keyframe-accurate,
// can drift up to one GOP but cheap.
//
// Source preference: when the local source cache file exists, ffmpeg
// reads from disk (instant seek). Otherwise we use the TorBox URL and
// kick off a background download so subsequent chunks go local.
// File shape: segment_<variant>_<NNNNN>.ts (e.g. segment_source_00012.ts).
func (h *Handler) serveHLSSegment(c echo.Context, sess *hlsSession, file string) error {
	// Strip the prefix and suffix, split on "_" — variant first, number second.
	body := strings.TrimSuffix(strings.TrimPrefix(file, "segment_"), ".ts")
	lastUnderscore := strings.LastIndex(body, "_")
	if lastUnderscore < 0 {
		return c.NoContent(http.StatusBadRequest)
	}
	variant := body[:lastUnderscore]
	numPart := body[lastUnderscore+1:]
	n, err := strconv.Atoi(numPart)
	if err != nil || n < 0 {
		return c.NoContent(http.StatusBadRequest)
	}

	key := ramCacheKey(sess.id, variant, n)
	ram := getHLSRAMCache()

	// Tier 1 — RAM cache. Sub-ms hit, no syscall, ideal for re-seek
	// inside the playback window.
	if data, ok := ram.Get(key); ok {
		c.Response().Header().Set("Content-Type", "video/mp2t")
		c.Response().Header().Set("Cache-Control", "public, max-age=3600")
		c.Response().Header().Set("X-Hls-Source", "ram")
		return c.Blob(http.StatusOK, "video/mp2t", data)
	}

	// Tier 2 — disk cache.
	cachePath := h.hlsChunkCacheVariantPath(sess.id, variant, n)
	if info, statErr := os.Stat(cachePath); statErr == nil && info.Size() > 0 {
		// Promote into RAM on the way out — next re-seek is free.
		if data, rerr := os.ReadFile(cachePath); rerr == nil {
			ram.Put(key, data)
		}
		c.Response().Header().Set("Content-Type", "video/mp2t")
		c.Response().Header().Set("Cache-Control", "public, max-age=3600")
		c.Response().Header().Set("X-Hls-Source", "cache")
		return c.File(cachePath)
	}

	if float64(n)*hlsSegDurSec >= sess.duration {
		return c.NoContent(http.StatusNotFound)
	}

	// Tier 3 — bake. bakeOneHLSChunk populates BOTH disk + RAM.
	if err := h.bakeOneHLSChunk(sess, variant, n); err != nil {
		log.Printf("hls seg %s/%d: bake failed: %v", variant, n, err)
		return c.JSON(http.StatusBadGateway, map[string]any{"error": "ffmpeg failed"})
	}
	if data, ok := ram.Get(key); ok {
		c.Response().Header().Set("Content-Type", "video/mp2t")
		c.Response().Header().Set("Cache-Control", "public, max-age=3600")
		c.Response().Header().Set("X-Hls-Source", "ffmpeg")
		return c.Blob(http.StatusOK, "video/mp2t", data)
	}
	c.Response().Header().Set("Content-Type", "video/mp2t")
	c.Response().Header().Set("Cache-Control", "public, max-age=3600")
	c.Response().Header().Set("X-Hls-Source", "ffmpeg")
	return c.File(cachePath)
}

// prebakeHLSChunks generates the first N chunks to disk in the
// background so the browser's first few segment requests hit the cache
// instantly instead of paying ffmpeg's cold-start cost on a remote
// source. Run as a fire-and-forget goroutine from /torbox/play.
//
// Concurrency: hlsPrebakeConcurrency ffmpeg processes run in
// parallel, each issuing range requests to TorBox independently.
// Since the source variant is `-c copy` the cost per chunk is mostly
// HTTP latency (1-2 s), so 4 in flight cuts wall-time roughly 3-4×
// vs sequential without saturating TorBox's per-IP limits.
//
// If 4 chunks have failed (likely a TorBox rate-limit or 5xx), we
// stop spawning more — no point burning CDN budget.
func (h *Handler) prebakeHLSChunks(sess *hlsSession, count int) {
	if sess == nil {
		return
	}
	start := time.Now()

	sem := make(chan struct{}, hlsPrebakeConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var done, failed int

	for i := 0; i < count; i++ {
		path := h.hlsChunkCacheVariantPath(sess.id, "source", i)
		if info, err := os.Stat(path); err == nil && info.Size() > 0 {
			mu.Lock()
			done++
			mu.Unlock()
			continue
		}
		mu.Lock()
		bail := failed >= 4
		mu.Unlock()
		if bail {
			break
		}

		wg.Add(1)
		sem <- struct{}{}
		go func(n int) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := h.bakeOneHLSChunk(sess, "source", n); err != nil {
				mu.Lock()
				failed++
				mu.Unlock()
				log.Printf("hls prebake: source chunk %d failed: %v", n, err)
				return
			}
			mu.Lock()
			done++
			mu.Unlock()
		}(i)
	}
	wg.Wait()

	log.Printf("hls prebake: session %s warmed %d/%d source chunks in %s",
		sess.id, done, count, time.Since(start).Round(100*time.Millisecond))
}

// bakeOneHLSChunk runs ffmpeg synchronously to generate one .ts segment
// for one ABR variant into the disk cache. Used by both the prebake
// path and the on-demand serveHLSSegment path.
func (h *Handler) bakeOneHLSChunk(sess *hlsSession, variantName string, n int) error {
	startSec := float64(n) * hlsSegDurSec
	if startSec >= sess.duration {
		return fmt.Errorf("chunk %d beyond duration", n)
	}
	segDur := hlsSegDurSec
	if startSec+segDur > sess.duration {
		segDur = sess.duration - startSec
	}

	// Locate the variant config.
	var variant hlsVariant
	for _, v := range hlsVariants() {
		if v.Name == variantName {
			variant = v
			break
		}
	}
	if variant.Name == "" {
		return fmt.Errorf("unknown variant %q", variantName)
	}

	inputPath := sess.url

	cachePath := h.hlsChunkCacheVariantPath(sess.id, variantName, n)
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return err
	}
	tmpPath := cachePath + ".tmp"

	// 720p re-encoding can take 5-10s for a single chunk on slower
	// CPUs (raspi, low-end NUC). The source variant is `-c copy` and
	// completes in <1s. Both bounded by 90s for safety.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// Audio handling:
	//   - AAC source → `-c:a copy` for the source variant (bit-perfect).
	//     For 720p variant, we always re-encode to a fixed AAC 192k
	//     stereo to normalise the audio bitrate across variants.
	//   - Anything else → re-encode to AAC stereo on both variants.
	audioArgs := []string{"-c:a", "aac", "-b:a", "192k", "-ac", "2"}
	if variantName == "source" && strings.HasPrefix(strings.ToLower(sess.audioCodec), "aac") {
		audioArgs = []string{"-c:a", "copy"}
	}

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-ss", fmt.Sprintf("%.3f", startSec),
	}
	// HTTP demuxer resilience — applies whenever the input is a URL.
	if strings.HasPrefix(inputPath, "http://") || strings.HasPrefix(inputPath, "https://") {
		args = append(args, ffmpegHTTPInputFlags()...)
	}
	args = append(args,
		"-i", inputPath,
		"-t", fmt.Sprintf("%.3f", segDur),
	)
	// Video filter for downscale (720p) goes before the video codec.
	if variant.Scale != "" {
		args = append(args, "-vf", variant.Scale)
	}
	args = append(args, variant.VideoArgs...)
	if variant.VideoBR != "" {
		args = append(args, "-b:v", variant.VideoBR, "-maxrate", variant.VideoBR, "-bufsize", "4000k")
	}
	args = append(args, audioArgs...)
	args = append(args,
		"-output_ts_offset", fmt.Sprintf("%.3f", startSec),
		"-mpegts_copyts", "1",
		"-f", "mpegts",
		"-y",
		tmpPath,
	)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("%v | %s", err, strings.TrimSpace(stderr.String()))
	}
	if err := os.Rename(tmpPath, cachePath); err != nil {
		return err
	}
	// Promote into RAM cache. Read errors are non-fatal — the disk
	// file is still good and the next serve will re-attempt the load.
	if data, err := os.ReadFile(cachePath); err == nil {
		getHLSRAMCache().Put(ramCacheKey(sess.id, variantName, n), data)
	}
	return nil
}

// ProbeResult is the full set of facts we extract from a single ffprobe
// run. Audio codec drives the HLS vs direct decision, video codec +
// container drive the same (via canPlayType on the client), and the
// subtitle list drives the prep UI.
type ProbeResult struct {
	Duration   float64
	AudioCodec string // "aac" / "ac3" / "eac3" / "dts" / "truehd" / ""
	VideoCodec string // "h264" / "hevc" / "vp9" / "av1" / "xvid" / "mpeg4" / ""
	Container  string // "mp4" / "matroska,webm" / "avi" / "" — ffprobe format_name verbatim
	Subtitles  []SubtitleTrack
}

// probeMediaInfo returns just the duration + audio codec for callers
// that don't need the full picture. Kept as a backwards-compat shim.
func probeMediaInfo(parent context.Context, url string) (float64, string) {
	res := probeMediaResult(parent, url)
	return res.Duration, res.AudioCodec
}

// probeMediaFull is a backwards-compat shim returning just (dur, audio, subs).
// New callers should use probeMediaResult which also exposes the video
// codec and container format.
func probeMediaFull(parent context.Context, url string) (float64, string, []SubtitleTrack) {
	res := probeMediaResult(parent, url)
	return res.Duration, res.AudioCodec, res.Subtitles
}

// probeMediaResult runs a single ffprobe invocation that returns the
// duration, the first audio stream's codec, the first video stream's
// codec, the container format, and every subtitle stream in the
// source (with language + codec metadata).
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
func probeMediaResult(parent context.Context, url string) ProbeResult {
	ctx, cancel := context.WithTimeout(parent, 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-analyzeduration", "60M",
		"-probesize", "200M",
		// format_name + duration come from format=; codec_name/type
		// + tags come from stream=. format_name is a comma-joined list
		// e.g. "mov,mp4,m4a,3gp,3g2,mj2" for MP4-family or
		// "matroska,webm" for MKV.
		"-show_entries", "format=duration,format_name:stream=codec_name,codec_type:stream_tags=language,title",
		"-of", "default=noprint_wrappers=1",
		url,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		log.Printf("ffprobe FAIL: %v | %s", err, strings.TrimSpace(stderr.String()))
		return ProbeResult{}
	}

	var (
		dur       float64
		audio     string
		video     string
		container string
		subs      []SubtitleTrack
		subIdx    int
		curName   string
		curType   string
		curLang   string
		curTitle  string
	)
	flush := func() {
		switch curType {
		case "audio":
			if audio == "" {
				audio = strings.ToLower(curName)
			}
		case "video":
			if video == "" {
				video = strings.ToLower(curName)
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
		case strings.HasPrefix(line, "format_name="):
			container = strings.ToLower(strings.TrimPrefix(line, "format_name="))
		case strings.HasPrefix(line, "codec_name="):
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
	flush()

	if len(subs) > 0 {
		summary := make([]string, 0, len(subs))
		for _, s := range subs {
			summary = append(summary, fmt.Sprintf("%s/%s", s.Codec, s.Language))
		}
		log.Printf("ffprobe OK: dur=%.1fs container=%q v=%q a=%q subs=%d [%s]",
			dur, container, video, audio, len(subs), strings.Join(summary, ", "))
	} else {
		log.Printf("ffprobe OK: dur=%.1fs container=%q v=%q a=%q subs=0",
			dur, container, video, audio)
		log.Printf("ffprobe RAW:\n%s", strings.TrimRight(string(out), "\n"))
	}
	return ProbeResult{
		Duration:   dur,
		AudioCodec: audio,
		VideoCodec: video,
		Container:  container,
		Subtitles:  subs,
	}
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

// startHLSCleanup reaps sessions idle for more than 15 min. Each
// reaped session also has its on-disk chunk cache directory deleted
// so the disk doesn't slowly accumulate gigabytes of stale .ts files
// (each 2 hr movie = ~900 MB of cached chunks during playback).
//
// We keep the cleanup as a package-level function with the data dir
// captured at first-call time so the existing sync.Once pattern keeps
// working. dataDir is empty until the first openHLSSession runs.
var hlsCleanupDataDir string

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
					// Drop the RAM cache entries for this session so the
					// LRU isn't kept warm by long-dead chunks.
					getHLSRAMCache().DropSession(id)
					// rm -rf the per-session chunk cache.
					if hlsCleanupDataDir != "" {
						chunkDir := filepath.Join(hlsCleanupDataDir, "cache", "hls-chunks", id)
						if err := os.RemoveAll(chunkDir); err == nil {
							log.Printf("hls: cleared chunk cache %s", chunkDir)
						}
					}
				}
			}
			hlsLock.Unlock()
		}
	}()
}
