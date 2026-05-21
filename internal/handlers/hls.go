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

// SubtitleTrack describes one embedded subtitle stream we found inside
// the source file. The frontend builds a <track> element per entry;
// the user toggles between them from the native player's CC menu.
//
// Codec → support matrix:
//   subrip / srt    → convertible to WebVTT          ✓
//   ass / ssa       → convertible to WebVTT          ✓ (styling stripped)
//   webvtt / vtt    → passthrough                     ✓
//   mov_text        → convertible                     ✓
//   pgssub / hdmv   → graphical, needs OCR            ✗
//   dvdsub / vobsub → graphical, needs OCR            ✗
type SubtitleTrack struct {
	Index     int    `json:"index"`     // Subtitle stream index (0-based among subs)
	Codec     string `json:"codec"`     // ffprobe codec_name
	Language  string `json:"language"`  // ISO-639 tag, e.g. "fre" / "eng" / "jpn"
	Title     string `json:"title"`     // Optional descriptive label
	Supported bool   `json:"supported"` // false for graphical subs we can't convert
}

type hlsSession struct {
	id         string
	url        string
	duration   float64 // seconds, 0 if probe failed
	audioCodec string
	subtitles  []SubtitleTrack
	lastUsed   time.Time
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

	sess, err := openHLSSession(c.Request().Context(), raw, body.DurationSec, body.AudioCodec)
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
// hint{Duration,AudioCodec} are caller-provided ffprobe results — if
// non-empty we use them and only ffprobe again to discover subtitles
// (cheap because most tags are inline near the start of the file).
func openHLSSession(parent context.Context, sourceURL string, hintDur float64, hintAudio string) (*hlsSession, error) {
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

	dur, audio, subs := probeMediaFull(parent, sourceURL)
	if hintDur > 0 {
		dur = hintDur
	}
	if hintAudio != "" {
		audio = hintAudio
	}
	if dur == 0 {
		return nil, fmt.Errorf("ffprobe failed to read duration")
	}
	sess = &hlsSession{
		id:         sessionID,
		url:        sourceURL,
		duration:   dur,
		audioCodec: audio,
		subtitles:  subs,
		lastUsed:   time.Now(),
	}
	hlsLock.Lock()
	hlsSessions[sessionID] = sess
	hlsLock.Unlock()
	log.Printf("hls: opened session %s (dur=%.1fs codec=%s subs=%d)", sessionID, dur, audio, len(subs))
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
	}
	return c.NoContent(http.StatusNotFound)
}

// serveHLSSubtitle extracts a single subtitle stream from the source via
// ffmpeg and converts it to WebVTT on the fly. The result is small
// (typically 50-200 KB even for a full film).
//
// URL shape: /api/v1/stream/hls/<sessionId>/sub_<idx>.vtt[?translateTo=fr]
//   idx          — position in session.subtitles, NOT the absolute
//                  stream index in the source file.
//   translateTo  — when present + Anthropic key is configured, the
//                  extracted VTT is run through Claude to translate
//                  dialogue lines into the target language. Result is
//                  cached on disk under <datadir>/cache/subtitles/.
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
	// "Same language" → don't translate, just serve the original. Tests
	// the user's normalised BCP-47 against both the source's language
	// tag (often ISO-639-2) and the normalised version.
	if targetLang != "" && (targetLang == strings.ToLower(track.Language) ||
		translateLangName(targetLang) == translateLangName(track.Language)) {
		targetLang = ""
	}

	// Cache lookup — translated VTT.
	if targetLang != "" {
		if cached := h.readCachedTranslation(sess.id, n, targetLang); cached != nil {
			c.Response().Header().Set("Content-Type", "text/vtt; charset=utf-8")
			c.Response().Header().Set("Cache-Control", "public, max-age=86400")
			c.Response().Header().Set("X-Translation-Source", "cache")
			c.Response().WriteHeader(http.StatusOK)
			_, _ = c.Response().Writer.Write(cached)
			return nil
		}
	}

	// Pull the raw VTT from ffmpeg into a buffer. Done into memory
	// instead of streamed because we either (a) translate it before
	// emitting, or (b) write it both to the response and to disk —
	// neither flow can stream linearly.
	ctx, cancel := context.WithTimeout(c.Request().Context(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "warning",
		"-i", sess.url,
		"-map", fmt.Sprintf("0:s:%d", track.Index),
		"-c:s", "webvtt",
		"-f", "webvtt",
		"pipe:1",
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		log.Printf("hls sub %d: ffmpeg %v | %s", n, err, strings.TrimSpace(stderr.String()))
		return c.JSON(http.StatusBadGateway, map[string]any{"error": "ffmpeg failed"})
	}

	body := raw
	translationSource := "ffmpeg"
	if targetLang != "" && h.App.Anthropic.HasKey() {
		// Translation can take 10-30 s on a feature-length subtitle;
		// give it its own headroom. The request context still wins if
		// the client disconnects.
		trCtx, cancelTr := context.WithTimeout(c.Request().Context(), 5*time.Minute)
		defer cancelTr()
		translated, err := translateVTT(trCtx, h.App.Anthropic, raw, targetLang)
		if err == nil && len(translated) > 0 {
			body = translated
			translationSource = "claude"
			h.writeCachedTranslation(sess.id, n, targetLang, body)
		} else if err != nil {
			log.Printf("hls sub %d: translation failed, serving original: %v", n, err)
		}
	}

	c.Response().Header().Set("Content-Type", "text/vtt; charset=utf-8")
	c.Response().Header().Set("Cache-Control", "public, max-age=86400")
	c.Response().Header().Set("X-Translation-Source", translationSource)
	c.Response().WriteHeader(http.StatusOK)
	_, _ = c.Response().Writer.Write(body)
	return nil
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
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
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
