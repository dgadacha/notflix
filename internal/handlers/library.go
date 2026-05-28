package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"notflix/internal/core"
	"notflix/internal/database/models"
	"notflix/internal/library"

	"github.com/labstack/echo/v4"
)

// Local library handlers.
//
// Endpoints (all under /api/v1/local-library):
//
//	GET    /                  — matched files (home rail)
//	GET    /all               — every scanned row (admin settings view)
//	GET    /dir               — current configured directory
//	PUT    /dir               — set the directory (admin)
//	POST   /scan              — trigger a scan (admin)
//	GET    /scan/status       — last scan report (admin)
//	GET    /stream/:id        — serve the local file with HTTP Range
//
// The stream endpoint is the only NON-admin one: it's reached by
// /watch when the user clicks a local card. Auth via the regular
// session cookie applies.

// HandleListLocalLibrary — GET /api/v1/local-library
//
// Returns every scanned row that resolved to a TMDB id. Orphan rows
// (unmatched filenames) are filtered out so the home rail doesn't
// show cards with no poster.
func (h *Handler) HandleListLocalLibrary(c echo.Context) error {
	files, err := h.App.Database.ListMatchedLocalFiles()
	if err != nil {
		return RespondErr(c, err)
	}
	if files == nil {
		// Force an empty array in the JSON output instead of `null` —
		// the frontend iterates without a nil check.
		files = []*models.LocalFile{}
	}
	return RespondOK(c, files)
}

// HandleListAllLocalFiles — GET /api/v1/local-library/all
//
// Admin view. Surfaces unmatched rows so the user can spot files that
// need renaming (or removed from disk) before they show up in the
// rail.
func (h *Handler) HandleListAllLocalFiles(c echo.Context) error {
	files, err := h.App.Database.ListAllLocalFiles()
	if err != nil {
		return RespondErr(c, err)
	}
	matched, total, _ := h.App.Database.CountLocalFiles()
	return RespondOK(c, map[string]any{
		"files":   files,
		"matched": matched,
		"total":   total,
	})
}

// HandleGetLibraryDir — GET /api/v1/local-library/dir
//
// Returns the currently-configured directory, regardless of whether
// the source is the env var or the settings table.
func (h *Handler) HandleGetLibraryDir(c echo.Context) error {
	dir := h.App.Config.Library.Dir
	source := "unset"
	if dir != "" {
		// Same hint as the server-config UI: "env" vs "db".
		envVal := os.Getenv("NOTFLIX_LIBRARY_DIR")
		if envVal == dir {
			source = "env"
		} else {
			source = "db"
		}
	}
	return RespondOK(c, map[string]any{
		"dir":    dir,
		"source": source,
	})
}

// HandleSetLibraryDir — PUT /api/v1/local-library/dir
//
// Persists the directory to the settings table + hot-swaps the
// in-memory Config. Empty string clears the override (env var
// fallback applies on next boot).
//
// The path is validated only loosely (existence + isDir). We don't
// resolve symlinks or sandbox to a known prefix — the admin who sets
// this is the same person who controls the host.
func (h *Handler) HandleSetLibraryDir(c echo.Context) error {
	var body struct {
		Dir string `json:"dir"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	body.Dir = strings.TrimSpace(body.Dir)

	if body.Dir != "" {
		info, err := os.Stat(body.Dir)
		if err != nil {
			return c.JSON(http.StatusBadRequest, map[string]any{
				"error": "dir not accessible: " + err.Error(),
			})
		}
		if !info.IsDir() {
			return c.JSON(http.StatusBadRequest, map[string]any{
				"error": "path is not a directory",
			})
		}
	}

	if err := h.App.ApplyLibraryDir(body.Dir); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, map[string]any{"dir": body.Dir})
}

// -----------------------------------------------------------------------------
// Scan trigger + last-report
// -----------------------------------------------------------------------------
//
// Scan coordination state lives in internal/library (runner.go) so both
// this handler AND the fsnotify watcher can trigger scans through the
// same lock. The handler is now a thin shim that just calls
// library.TryRunInBackground and translates the bool result to HTTP.

// HandleScanLocalLibrary — POST /api/v1/local-library/scan
//
// Fire-and-forget: returns 202 with {started: true}. The scan runs in
// a goroutine inside library.TryRunInBackground. The frontend polls
// /scan/status every ~1.5 s to render the progress bar.
//
// 409 when a scan is already running (either another manual trigger,
// or the watcher auto-scan firing concurrently).
func (h *Handler) HandleScanLocalLibrary(c echo.Context) error {
	dir := h.App.Config.Library.Dir
	if dir == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "library dir not configured — set it first via PUT /local-library/dir",
		})
	}
	if !library.TryRunInBackground(dir, h.App.TMDB, h.App.Database, "manual") {
		return c.JSON(http.StatusConflict, map[string]any{
			"error": "scan already in progress",
		})
	}
	return c.JSON(http.StatusAccepted, map[string]any{
		"started": true,
		"dir":     dir,
	})
}

// HandleScanStatus — GET /api/v1/local-library/scan/status
//
// Returns the in-flight progress (current/total/currentFile) when a
// scan is running, plus the last finished scan's report. The settings
// panel polls this every ~1.5 s to render a live progress bar.
func (h *Handler) HandleScanStatus(c echo.Context) error {
	return RespondOK(c, map[string]any{
		"running":    library.IsRunning(),
		"progress":   library.Progress(),
		"lastReport": library.LastReport(),
		"trigger":    library.LastTrigger(),
	})
}

// HandleLibraryEvents — GET /api/v1/local-library/events
//
// Server-Sent Events stream. Every time the fsnotify watcher detects a
// new file landing in the library dir AND the scanner resolves it to a
// TMDB match, one event of shape:
//
//	data: {"kind":"added","title":"Dune","mediaType":"movie", … }\n\n
//
// is pushed down this stream. The frontend opens an EventSource on
// this endpoint and renders a toast per event.
//
// The connection is held open by writing a heartbeat comment line every
// 15 s — Cloudflare Tunnel + browser idle timers would otherwise drop
// the socket after ~60 s of silence.
func (h *Handler) HandleLibraryEvents(c echo.Context) error {
	resp := c.Response()
	resp.Header().Set("Content-Type", "text/event-stream")
	resp.Header().Set("Cache-Control", "no-cache")
	resp.Header().Set("Connection", "keep-alive")
	resp.Header().Set("X-Accel-Buffering", "no") // disable nginx/CF buffering
	resp.WriteHeader(http.StatusOK)
	flusher, ok := resp.Writer.(http.Flusher)
	if !ok {
		return fmt.Errorf("streaming not supported")
	}

	ch, cleanup := library.Subscribe()
	defer cleanup()

	// Initial comment so curl shows something immediately and so
	// EventSource fires `open` on connect (it waits for first byte).
	if _, err := fmt.Fprintf(resp, ": library-events stream open\n\n"); err != nil {
		return nil
	}
	flusher.Flush()

	ctx := c.Request().Context()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-heartbeat.C:
			if _, err := fmt.Fprintf(resp, ": ping\n\n"); err != nil {
				return nil
			}
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			payload, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(resp, "data: %s\n\n", payload); err != nil {
				return nil
			}
			flusher.Flush()
		}
	}
}

// -----------------------------------------------------------------------------
// Stream
// -----------------------------------------------------------------------------

// HandleStreamLocalFile — GET /api/v1/local-library/stream/:id
//
// Serves the file at the path stored on the LocalFile row, with full
// HTTP Range support (Echo wraps http.ServeFile which does Range
// natively). The browser plays via <video src> when the codec is
// browser-native (H.264/AAC in MP4 mostly); otherwise the existing
// HLS transmux path can be used by /watch — that route accepts any
// URL, file:// or http://, so the local path resolves transparently.
//
// Security: we don't trust the row blindly. After loading the LocalFile
// we re-check the path is under the configured library directory. This
// prevents a stale row + a moved library dir from accidentally serving
// outside the new dir.
func (h *Handler) HandleStreamLocalFile(c echo.Context) error {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return c.NoContent(http.StatusBadRequest)
	}
	f, err := h.App.Database.GetLocalFile(uint(id))
	if err != nil {
		return c.NoContent(http.StatusNotFound)
	}

	// Re-anchor under the configured library dir. If the dir changed
	// since this row was created, refuse to serve.
	configuredDir := strings.TrimSpace(h.App.Config.Library.Dir)
	if configuredDir == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]any{
			"error": "library dir not configured",
		})
	}
	absDir, err := filepath.Abs(configuredDir)
	if err != nil {
		return c.NoContent(http.StatusInternalServerError)
	}
	absFile, err := filepath.Abs(f.Path)
	if err != nil {
		return c.NoContent(http.StatusInternalServerError)
	}
	// Use filepath.Rel — a path is "under" the dir iff rel doesn't
	// start with "..". Cheaper + more correct than strings.HasPrefix
	// (handles trailing slash + case-insensitive FS edge cases).
	rel, err := filepath.Rel(absDir, absFile)
	if err != nil || strings.HasPrefix(rel, "..") {
		return c.JSON(http.StatusForbidden, map[string]any{
			"error": "file outside configured library dir",
		})
	}

	// Stat for size + headers. 404 if it's gone.
	info, err := os.Stat(absFile)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]any{
			"error": "file no longer exists on disk — re-scan to clean up",
		})
	}
	_ = info

	// Content-Type by extension — the browser uses this hint to pick
	// the right <video> decoder. Falls through to application/octet-
	// stream if unknown, which the browser still tries to decode for
	// known magic-byte signatures.
	switch strings.ToLower(filepath.Ext(absFile)) {
	case ".mp4", ".m4v":
		c.Response().Header().Set("Content-Type", "video/mp4")
	case ".mkv":
		c.Response().Header().Set("Content-Type", "video/x-matroska")
	case ".webm":
		c.Response().Header().Set("Content-Type", "video/webm")
	case ".avi":
		c.Response().Header().Set("Content-Type", "video/x-msvideo")
	case ".mov":
		c.Response().Header().Set("Content-Type", "video/quicktime")
	}
	c.Response().Header().Set("Accept-Ranges", "bytes")
	// Long cache — the file content is content-addressable by the id
	// since the row is unique per path. Re-scan would change the id.
	c.Response().Header().Set("Cache-Control", "private, max-age=86400")
	return c.File(absFile)
}

// -----------------------------------------------------------------------------
// Pipe transmux — single-pipe ffmpeg for local files
// -----------------------------------------------------------------------------

// HandleTransmuxLocalFile — GET /api/v1/local-library/transmux/:id
//
// Single-pipe ffmpeg → fragmented MP4 streamed straight to the browser.
// Used for local MKV files whose audio codec (AC3/EAC3/DTS/TrueHD) the
// browser can't decode natively.
//
// Why a single pipe instead of HLS chunked:
//   - HLS chunked with `-c:v copy` requires every segment to start on
//     a keyframe. Source keyframes rarely align to multiples of the
//     segment duration → boundaries fall mid-GOP → missing frames,
//     visible skips. The chunked path also spawns one ffmpeg per
//     segment which adds CPU + latency per chunk.
//   - A single pipe reads the source linearly, copies video bit-perfect,
//     transmuxes audio to AAC on the fly, and emits fragmented MP4
//     boxes as they're ready. The browser plays it like any other
//     <video src> — buffering is browser-native.
//
// Seek model:
//   - Forward seek inside the buffered range: handled natively by the
//     browser, no server involvement.
//   - Backward seek inside the buffered range: same.
//   - Seek OUTSIDE the buffered range: the frontend reloads the src
//     with `?t=<targetSeconds>` so a fresh ffmpeg starts at that
//     position. This causes a brief pause but plays from the new
//     position cleanly.
//
// Audio handling: always transmuxed (`-c:a aac -b:a 192k -ac 2`)
// with `aresample=async=1000` to keep audio aligned with video
// timestamps across the lifetime of the stream. Video is bit-perfect
// copied; we never re-encode the picture.
func (h *Handler) HandleTransmuxLocalFile(c echo.Context) error {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return c.NoContent(http.StatusBadRequest)
	}
	f, err := h.App.Database.GetLocalFile(uint(id))
	if err != nil {
		return c.NoContent(http.StatusNotFound)
	}

	// Re-anchor under the configured library dir (same security check
	// as the raw stream endpoint).
	configuredDir := strings.TrimSpace(h.App.Config.Library.Dir)
	if configuredDir == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]any{
			"error": "library dir not configured",
		})
	}
	absDir, err := filepath.Abs(configuredDir)
	if err != nil {
		return c.NoContent(http.StatusInternalServerError)
	}
	absFile, err := filepath.Abs(f.Path)
	if err != nil {
		return c.NoContent(http.StatusInternalServerError)
	}
	rel, err := filepath.Rel(absDir, absFile)
	if err != nil || strings.HasPrefix(rel, "..") {
		return c.JSON(http.StatusForbidden, map[string]any{
			"error": "file outside configured library dir",
		})
	}
	if _, err := os.Stat(absFile); err != nil {
		return c.JSON(http.StatusNotFound, map[string]any{
			"error": "file no longer exists on disk",
		})
	}

	// Parse the seek-to position. 0 = start of file.
	startSec := 0.0
	if t := c.QueryParam("t"); t != "" {
		if v, err := strconv.ParseFloat(t, 64); err == nil && v > 0 {
			startSec = v
		}
	}

	// Stream headers. No Range support — a pipe can't seek backwards.
	// The frontend handles "seek outside buffer" by reloading the src
	// with a new ?t= value, which spawns a fresh ffmpeg at that
	// position.
	resp := c.Response()
	resp.Header().Set("Content-Type", "video/mp4")
	resp.Header().Set("Cache-Control", "no-cache, no-store")
	resp.Header().Set("Accept-Ranges", "none")
	resp.WriteHeader(http.StatusOK)

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
	}
	if startSec > 0 {
		// -ss before -i = fast seek (keyframe-aligned). Off by a few
		// hundred ms typically, which is fine for "user seeked here".
		args = append(args, "-ss", fmt.Sprintf("%.3f", startSec))
	}
	args = append(args,
		"-i", absFile,
		// Video: bit-perfect copy. We never re-encode the picture.
		"-c:v", "copy",
		// Audio: transmux to AAC stereo with drift correction so the
		// audio doesn't slide against the video over time.
		"-c:a", "aac",
		"-b:a", "192k",
		"-ac", "2",
		"-af", "aresample=async=1000",
		// fMP4 streaming flags. We deliberately DROP +empty_moov so
		// ffmpeg writes a real moov upfront containing the mvhd with
		// the source's total duration. Without that, the browser
		// computes duration from fragments-seen-so-far → the timeline
		// grows as the user watches instead of showing the real total
		// from the start.
		//   frag_keyframe      : new fragment on every video keyframe
		//   default_base_moof  : timestamps relative to moof (not file)
		//   omit_tfhd_offset   : don't write absolute byte offsets
		"-movflags", "+frag_keyframe+default_base_moof+omit_tfhd_offset",
		// Force fragment cadence even when the source has long GOPs.
		// One second = decent UX without too many tiny fragments.
		"-frag_duration", "1000000",
		"-f", "mp4",
		"pipe:1",
	)

	ctx := c.Request().Context()
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdout = resp.Writer
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// If the context was cancelled (client disconnected), that's
		// expected and not really an error.
		if ctx.Err() != nil {
			return nil
		}
		// We've already written 200 OK + started piping, so we can't
		// return a JSON error. Just log + close.
		fmt.Printf("transmux %d: ffmpeg failed: %v | %s\n", id, err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// -----------------------------------------------------------------------------
// Probe — total duration + codec metadata for the player UI
// -----------------------------------------------------------------------------

// HandleProbeLocalFile — GET /api/v1/local-library/probe/:id
//
// Returns the source duration (seconds) + audio/video codec names by
// running ffprobe against the file on disk. The frontend uses this to
// size the custom timeline correctly: the pipe transmux endpoint
// streams progressively, so the browser's <video>.duration grows over
// time. With this probe, the player UI shows the REAL duration from
// the moment the user lands on /watch, and can map a scrub-bar click
// at 50 % to an absolute file position.
//
// Cached per-file in-memory for 1 hour: ffprobe takes 100-300 ms even
// on a local SSD and a single user can request /probe + /transmux
// back-to-back on every play.
type localProbeResp struct {
	Duration   float64 `json:"duration"`   // seconds
	AudioCodec string  `json:"audioCodec"`
	VideoCodec string  `json:"videoCodec"`
}

var (
	localProbeMu    sync.Mutex
	localProbeCache = map[uint]localProbeEntry{}
)
type localProbeEntry struct {
	at  time.Time
	val localProbeResp
}

func (h *Handler) HandleProbeLocalFile(c echo.Context) error {
	idStr := c.Param("id")
	id64, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		return c.NoContent(http.StatusBadRequest)
	}
	id := uint(id64)

	// Cache check — same id → same path → same probe.
	localProbeMu.Lock()
	if e, ok := localProbeCache[id]; ok && time.Since(e.at) < time.Hour {
		localProbeMu.Unlock()
		return RespondOK(c, e.val)
	}
	localProbeMu.Unlock()

	f, err := h.App.Database.GetLocalFile(id)
	if err != nil {
		return c.NoContent(http.StatusNotFound)
	}
	configuredDir := strings.TrimSpace(h.App.Config.Library.Dir)
	if configuredDir == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]any{
			"error": "library dir not configured",
		})
	}
	absDir, _ := filepath.Abs(configuredDir)
	absFile, _ := filepath.Abs(f.Path)
	rel, err := filepath.Rel(absDir, absFile)
	if err != nil || strings.HasPrefix(rel, "..") {
		return c.JSON(http.StatusForbidden, map[string]any{
			"error": "file outside configured library dir",
		})
	}

	probe := probeMediaResult(c.Request().Context(), absFile)
	resp := localProbeResp{
		Duration:   probe.Duration,
		AudioCodec: probe.AudioCodec,
		VideoCodec: probe.VideoCodec,
	}
	localProbeMu.Lock()
	localProbeCache[id] = localProbeEntry{at: time.Now(), val: resp}
	localProbeMu.Unlock()
	return RespondOK(c, resp)
}

// Compile-time link check: ensure core.SettingLibraryDir is exported
// at the expected name (we reference it via the App helper above).
var _ = core.SettingLibraryDir
