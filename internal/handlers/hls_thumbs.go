package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// HLS scrub-bar thumbnails.
//
// Generates a sprite-based thumbnail track for the seek-bar preview.
// One thumb every hlsThumbIntervalSec, tiled into hlsThumbsPerSprite-
// per-sprite sheets. The frontend hovers on the player and reads the
// VTT manifest to find which sprite + offset to render.
//
// Why sprites instead of individual frames? Browsers compose sprites
// for free via CSS object-position; serving thousands of tiny .jpg
// files would saturate the HTTP/2 connection on every drag.

const (
	hlsThumbIntervalSec = 10.0 // one frame per 10 s
	hlsThumbWidth       = 160
	hlsThumbHeight      = 90
	hlsThumbCols        = 10
	hlsThumbRows        = 10
	hlsThumbsPerSprite  = hlsThumbCols * hlsThumbRows // 100
)

// In-flight guard so the same session doesn't fire ffmpeg twice if
// /torbox/play is called concurrently for the same source URL.
var (
	hlsThumbsBuildingMu sync.Mutex
	hlsThumbsBuilding   = map[string]bool{}
)

func (h *Handler) hlsThumbsDir(sessionID string) string {
	return filepath.Join(h.App.Config.Data.Dir, "cache", "hls-thumbs", sessionID)
}

// generateThumbnails kicks off the sprite generation for a session in
// a background goroutine. Safe to call multiple times — the in-flight
// guard collapses duplicate calls.
//
// Cost: one ffmpeg pass per sprite (~5-10 s each on a remote source
// for the fps filter). For a 2 h movie that's ~7 sprites = 1 min of
// background work. Runs in parallel with chunk prebake.
func (h *Handler) generateThumbnails(sess *hlsSession) {
	if sess == nil || sess.duration <= 0 {
		return
	}

	hlsThumbsBuildingMu.Lock()
	if hlsThumbsBuilding[sess.id] {
		hlsThumbsBuildingMu.Unlock()
		return
	}
	hlsThumbsBuilding[sess.id] = true
	hlsThumbsBuildingMu.Unlock()

	go func() {
		defer func() {
			hlsThumbsBuildingMu.Lock()
			delete(hlsThumbsBuilding, sess.id)
			hlsThumbsBuildingMu.Unlock()
		}()

		dir := h.hlsThumbsDir(sess.id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Printf("hls thumbs: mkdir failed: %v", err)
			return
		}

		// If the VTT already exists + non-empty, assume the previous
		// session left a complete set. Sprite generation is idempotent
		// on disk so this just saves re-doing the work.
		vttPath := filepath.Join(dir, "index.vtt")
		if info, err := os.Stat(vttPath); err == nil && info.Size() > 0 {
			return
		}

		totalThumbs := int(sess.duration/hlsThumbIntervalSec) + 1
		totalSprites := (totalThumbs + hlsThumbsPerSprite - 1) / hlsThumbsPerSprite

		start := time.Now()
		for n := 0; n < totalSprites; n++ {
			if err := h.bakeThumbnailSprite(sess, n); err != nil {
				log.Printf("hls thumbs: sprite %d failed: %v", n, err)
				return
			}
		}

		// Write the VTT manifest only after every sprite is on disk —
		// partial manifests would tell hls.js to fetch sprite files
		// that don't exist yet, surfacing as broken images.
		if err := h.writeThumbnailVTT(sess, totalThumbs); err != nil {
			log.Printf("hls thumbs: vtt write failed: %v", err)
			return
		}
		log.Printf("hls thumbs: session %s — %d sprites (%d thumbs) generated in %s",
			sess.id, totalSprites, totalThumbs, time.Since(start).Round(time.Second))
	}()
}

// bakeThumbnailSprite emits ONE sprite covering thumbs
// [n*hlsThumbsPerSprite, (n+1)*hlsThumbsPerSprite). Uses ffmpeg's
// `fps + scale + tile` filter chain to produce the tiled JPEG in a
// single pass.
//
// `-ss` BEFORE `-i` keyframe-seeks to the start of the window — fast
// on remote sources where libavformat would otherwise scan from byte
// 0. The cost is sub-second precision (we land on the nearest
// keyframe), which doesn't matter for a 10 s-interval preview.
func (h *Handler) bakeThumbnailSprite(sess *hlsSession, n int) error {
	dir := h.hlsThumbsDir(sess.id)
	path := filepath.Join(dir, fmt.Sprintf("sprite_%03d.jpg", n))
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		return nil // already baked
	}

	startSec := float64(n*hlsThumbsPerSprite) * hlsThumbIntervalSec
	if startSec >= sess.duration {
		return fmt.Errorf("sprite %d starts past duration", n)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-ss", fmt.Sprintf("%.3f", startSec),
	}
	if strings.HasPrefix(sess.url, "http://") || strings.HasPrefix(sess.url, "https://") {
		args = append(args, ffmpegHTTPInputFlags()...)
	}
	args = append(args,
		"-i", sess.url,
		// -an: drop audio. Saves demux work.
		"-an",
		// fps=1/N: emit one frame every N seconds. scale: shrink to
		// thumb size keeping aspect ratio (-2 = "make height even but
		// match the requested width"). tile: pack frames into a grid.
		"-vf", fmt.Sprintf(
			"fps=1/%.0f,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,tile=%dx%d",
			hlsThumbIntervalSec, hlsThumbWidth, hlsThumbHeight, hlsThumbWidth, hlsThumbHeight, hlsThumbCols, hlsThumbRows,
		),
		"-frames:v", "1",
		// -q:v 5 is a sweet spot for sub-mb sprites with no visible
		// blocking at the 160×90 thumb size.
		"-q:v", "5",
		"-y",
		path,
	)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("ffmpeg: %v | %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// writeThumbnailVTT generates the WebVTT manifest mapping each thumb
// timestamp to a sprite + (x,y,w,h) rectangle. The browser-supported
// `#xywh=` fragment doesn't actually clip the image — that's our job
// in JS — but we follow the convention so the file is greppable and
// recognisably-shaped.
func (h *Handler) writeThumbnailVTT(sess *hlsSession, totalThumbs int) error {
	var b strings.Builder
	b.WriteString("WEBVTT\n\n")
	for i := 0; i < totalThumbs; i++ {
		startSec := float64(i) * hlsThumbIntervalSec
		endSec := startSec + hlsThumbIntervalSec
		if endSec > sess.duration {
			endSec = sess.duration
		}
		spriteN := i / hlsThumbsPerSprite
		posInSprite := i % hlsThumbsPerSprite
		col := posInSprite % hlsThumbCols
		row := posInSprite / hlsThumbCols
		x := col * hlsThumbWidth
		y := row * hlsThumbHeight

		fmt.Fprintf(&b, "%s --> %s\n", vttTimestamp(startSec), vttTimestamp(endSec))
		fmt.Fprintf(&b, "sprite_%03d.jpg#xywh=%d,%d,%d,%d\n\n",
			spriteN, x, y, hlsThumbWidth, hlsThumbHeight)
	}
	vttPath := filepath.Join(h.hlsThumbsDir(sess.id), "index.vtt")
	return os.WriteFile(vttPath, []byte(b.String()), 0o644)
}

func vttTimestamp(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	h := int(sec) / 3600
	m := (int(sec) % 3600) / 60
	s := int(sec) % 60
	ms := int((sec - float64(int(sec))) * 1000)
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, ms)
}

// serveHLSThumb routes either to the VTT manifest or to one sprite
// file. The route dispatcher in hls.go has already stripped the
// `thumbs_` prefix; we accept `index.vtt` and `sprite_NNN.jpg` shapes.
//
// URL flatness matters: the parent HLS dispatch rejects path
// separators in the wildcard for path-traversal safety, so the
// frontend uses `thumbs_index.vtt` / `thumbs_sprite_000.jpg` rather
// than the natural `thumbs/...` layout. The on-disk layout under
// hlsThumbsDir is still `sprite_NNN.jpg + index.vtt` — only the URL
// is flattened.
//
// The VTT references sprites by `sprite_NNN.jpg`, NOT by the
// flattened URL shape. The frontend rewrites the URL to add the
// `thumbs_` prefix when fetching sprites; see the player.
func (h *Handler) serveHLSThumb(c echo.Context, sess *hlsSession, file string) error {
	dir := h.hlsThumbsDir(sess.id)
	switch {
	case file == "index.vtt":
		path := filepath.Join(dir, "index.vtt")
		if info, err := os.Stat(path); err != nil || info.Size() == 0 {
			// 404 — the frontend treats this as "no thumbs available
			// (yet)" and falls back to a plain seek bar.
			return c.NoContent(http.StatusNotFound)
		}
		c.Response().Header().Set("Content-Type", "text/vtt")
		c.Response().Header().Set("Cache-Control", "public, max-age=3600")
		return c.File(path)
	case strings.HasPrefix(file, "sprite_") && strings.HasSuffix(file, ".jpg"):
		body := strings.TrimSuffix(strings.TrimPrefix(file, "sprite_"), ".jpg")
		n, err := strconv.Atoi(body)
		if err != nil || n < 0 || n > 9999 {
			return c.NoContent(http.StatusBadRequest)
		}
		path := filepath.Join(dir, fmt.Sprintf("sprite_%03d.jpg", n))
		if info, err := os.Stat(path); err != nil || info.Size() == 0 {
			return c.NoContent(http.StatusNotFound)
		}
		c.Response().Header().Set("Content-Type", "image/jpeg")
		c.Response().Header().Set("Cache-Control", "public, max-age=3600")
		return c.File(path)
	}
	return c.NoContent(http.StatusNotFound)
}
