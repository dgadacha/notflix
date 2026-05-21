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

type hlsSession struct {
	id         string
	url        string
	duration   float64 // seconds, 0 if probe failed
	audioCodec string
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
// Returns: {"sessionId", "playlistUrl", "durationSec", "audioCodec"}
//
// If the caller already ffprobed the URL (e.g. /torbox/play just did it),
// they can pass `durationSec` + `audioCodec` and the HLS handler skips
// the re-probe — saves ~1-2s on the second hop.
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

	digest := sha256.Sum256([]byte(raw))
	sessionID := hex.EncodeToString(digest[:8])

	hlsLock.Lock()
	sess, exists := hlsSessions[sessionID]
	hlsLock.Unlock()

	if !exists {
		// Reuse caller's ffprobe result when provided, otherwise run
		// our own. Either way we need a valid duration to build the
		// VOD playlist.
		dur := body.DurationSec
		codec := body.AudioCodec
		if dur == 0 {
			dur, codec = probeMediaInfo(c.Request().Context(), raw)
		}
		if dur == 0 {
			return c.JSON(http.StatusBadGateway, map[string]any{
				"error": "ffprobe failed to read duration",
			})
		}
		sess = &hlsSession{
			id:         sessionID,
			url:        raw,
			duration:   dur,
			audioCodec: codec,
			lastUsed:   time.Now(),
		}
		hlsLock.Lock()
		hlsSessions[sessionID] = sess
		hlsLock.Unlock()
		log.Printf("hls: opened session %s (dur=%.1fs codec=%s)", sessionID, dur, codec)
	} else {
		hlsLock.Lock()
		sess.lastUsed = time.Now()
		hlsLock.Unlock()
	}

	hlsCleanupOnce.Do(startHLSCleanup)

	return RespondOK(c, map[string]any{
		"sessionId":   sessionID,
		"playlistUrl": "/api/v1/stream/hls/" + sessionID + "/index.m3u8",
		"durationSec": sess.duration,
		"audioCodec":  sess.audioCodec,
	})
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
	}
	return c.NoContent(http.StatusNotFound)
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

// probeMediaInfo runs ffprobe once to extract both the duration and the
// first audio stream codec. Returns (duration, "") on success, (0, "")
// on failure.
func probeMediaInfo(parent context.Context, url string) (float64, string) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-show_entries", "format=duration:stream=codec_name,codec_type",
		"-of", "default=noprint_wrappers=1",
		url,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		log.Printf("ffprobe FAIL: %v | %s", err, strings.TrimSpace(stderr.String()))
		return 0, ""
	}
	// Parse "codec_name=h264\ncodec_type=video\ncodec_name=aac\ncodec_type=audio\nduration=3599.456"
	var dur float64
	var audio string
	var pendingName string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "duration="):
			v, _ := strconv.ParseFloat(strings.TrimPrefix(line, "duration="), 64)
			if v > 0 {
				dur = v
			}
		case strings.HasPrefix(line, "codec_name="):
			pendingName = strings.TrimPrefix(line, "codec_name=")
		case line == "codec_type=audio":
			if audio == "" {
				audio = strings.ToLower(pendingName)
			}
		case strings.HasPrefix(line, "codec_type="):
			pendingName = ""
		}
	}
	log.Printf("ffprobe OK: duration=%.1fs audio=%q", dur, audio)
	return dur, audio
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
