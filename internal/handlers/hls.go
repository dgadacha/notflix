package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// HLS transmux session — one ffmpeg process per TorBox URL, writing
// segments + a growing playlist into /tmp/notflix-hls/<sessionID>/.
// The frontend hls.js loads the playlist + chunks; this is the only
// way to give the user a working seek bar on transmuxed content,
// because a one-way pipe (the old /transmux endpoint) can't honour
// byte-range requests.
type hlsSession struct {
	id       string
	dir      string
	cancel   func()
	lastUsed time.Time
}

var (
	hlsSessions    = map[string]*hlsSession{}
	hlsLock        sync.Mutex
	hlsRootDir     = filepath.Join(os.TempDir(), "notflix-hls")
	hlsCleanupOnce sync.Once
)

// HandleStreamHLSStart — POST /api/v1/stream/hls/start
//
// Body: {"url": "<torbox-cdn-url>"}
// Returns: {"sessionId": "abcd1234", "playlistUrl": "/api/v1/stream/hls/abcd1234/index.m3u8"}
//
// Reuses an existing ffmpeg session if one already targets the same
// URL — so reloading the player after a brief disconnect doesn't
// kick off a second ffmpeg.
func (h *Handler) HandleStreamHLSStart(c echo.Context) error {
	var body struct {
		URL string `json:"url"`
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

	// Session ID is the first 8 bytes of sha256(url) — stable across
	// requests for the same URL, short enough to fit in paths.
	digest := sha256.Sum256([]byte(raw))
	sessionID := hex.EncodeToString(digest[:8])

	hlsLock.Lock()
	sess, exists := hlsSessions[sessionID]
	if !exists {
		dir := filepath.Join(hlsRootDir, sessionID)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			hlsLock.Unlock()
			return RespondErr(c, err)
		}

		// Detach the ffmpeg lifetime from this request: the user may
		// close the play tab and come back — the segments + playlist
		// should still be around. Cleanup is by idle-timeout below.
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.CommandContext(ctx, "ffmpeg",
			"-hide_banner",
			"-loglevel", "warning",
			"-i", raw,
			"-c:v", "copy",     // remux video, no quality loss
			"-c:a", "aac",      // re-encode audio to AAC
			"-b:a", "192k",
			"-ac", "2",         // stereo downmix
			"-f", "hls",
			"-hls_time", "4",
			// "-hls_list_size", "0" keeps every segment in the playlist
			// so the seek bar can jump anywhere we've already encoded.
			"-hls_list_size", "0",
			"-hls_flags", "independent_segments+temp_file",
			"-hls_segment_filename", filepath.Join(dir, "segment_%05d.ts"),
			filepath.Join(dir, "index.m3u8"),
		)
		if err := cmd.Start(); err != nil {
			cancel()
			hlsLock.Unlock()
			return c.JSON(http.StatusBadGateway, map[string]any{
				"error": "ffmpeg failed to start: " + err.Error(),
			})
		}

		sess = &hlsSession{
			id:       sessionID,
			dir:      dir,
			cancel:   cancel,
			lastUsed: time.Now(),
		}
		hlsSessions[sessionID] = sess
		log.Printf("hls: started session %s → %s", sessionID, raw)
	}
	sess.lastUsed = time.Now()
	hlsLock.Unlock()

	// Wait for ffmpeg to produce the first version of the playlist —
	// at hls_time=4, that's ~4-5 s after start. Cap at 20 s so a
	// stalled CDN doesn't hang the client forever.
	m3u8Path := filepath.Join(sess.dir, "index.m3u8")
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(m3u8Path); err == nil && info.Size() > 0 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	hlsCleanupOnce.Do(startHLSCleanup)

	return RespondOK(c, map[string]any{
		"sessionId":   sessionID,
		"playlistUrl": "/api/v1/stream/hls/" + sessionID + "/index.m3u8",
	})
}

// HandleStreamHLSFile — GET /api/v1/stream/hls/:sessionId/*
//
// Serves either the m3u8 playlist or a .ts segment from the session
// directory. The session's lastUsed clock is bumped on every request
// so an actively-played stream stays alive past the cleanup timeout.
func (h *Handler) HandleStreamHLSFile(c echo.Context) error {
	sessionID := c.Param("sessionId")
	file := c.Param("*")
	if sessionID == "" || file == "" {
		return c.NoContent(http.StatusBadRequest)
	}
	// Block path traversal — file should be a plain segment name like
	// "segment_00042.ts" or "index.m3u8". No slashes, no "..".
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

	p := filepath.Join(sess.dir, file)
	switch {
	case strings.HasSuffix(file, ".m3u8"):
		c.Response().Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		c.Response().Header().Set("Cache-Control", "no-store")
	case strings.HasSuffix(file, ".ts"):
		c.Response().Header().Set("Content-Type", "video/mp2t")
		// Segments are immutable once written, can cache aggressively.
		c.Response().Header().Set("Cache-Control", "public, max-age=3600")
	}
	return c.File(p)
}

// startHLSCleanup spawns a single goroutine that reaps HLS sessions
// idle for more than 15 minutes — kills ffmpeg, removes the segment
// directory, drops the map entry.
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
					sess.cancel()
					_ = os.RemoveAll(sess.dir)
					delete(hlsSessions, id)
				}
			}
			hlsLock.Unlock()
		}
	}()
}
