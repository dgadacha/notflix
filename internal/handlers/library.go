package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
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
	torrentDir := h.App.TorrentDropDir()
	if !library.TryRunInBackground(dir, h.App.TMDB, h.App.Database, "manual", torrentDir, h.App.TorBox) {
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
// MKV → MP4 batch conversion
// -----------------------------------------------------------------------------

// HandleGetAutoConvert — GET /api/v1/local-library/auto-convert
//
// Returns whether the after-scan auto-convert toggle is enabled.
func (h *Handler) HandleGetAutoConvert(c echo.Context) error {
	return RespondOK(c, map[string]any{"enabled": h.App.AutoConvertEnabled()})
}

// HandleSetAutoConvert — PUT /api/v1/local-library/auto-convert
//
// Persists the auto-convert toggle. The after-scan hook reads the
// setting fresh on every fire so the change applies immediately.
func (h *Handler) HandleSetAutoConvert(c echo.Context) error {
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	if err := h.App.ApplyAutoConvert(body.Enabled); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, map[string]any{"enabled": body.Enabled})
}

// HandleGetTorrentDropDir — GET /api/v1/local-library/torrent-drop-dir
// Returns the directory the TorrentWatcher polls for incoming
// .torrent files. Empty string = feature off.
func (h *Handler) HandleGetTorrentDropDir(c echo.Context) error {
	return RespondOK(c, map[string]any{
		"dir": h.App.TorrentDropDir(),
	})
}

// HandleSetTorrentDropDir — PUT /api/v1/local-library/torrent-drop-dir
// Body: {"dir":"/abs/path"} ; empty string stops the watcher.
func (h *Handler) HandleSetTorrentDropDir(c echo.Context) error {
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
	if err := h.App.ApplyTorrentDropDir(body.Dir); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, map[string]any{"dir": body.Dir})
}

// HandleGetAudioLangPrefs — GET /api/v1/local-library/audio-langs
// Returns the two preferred audio language codes (default + anime).
func (h *Handler) HandleGetAudioLangPrefs(c echo.Context) error {
	def, anime := h.App.AudioLangPrefs()
	return RespondOK(c, map[string]any{
		"default": def,
		"anime":   anime,
	})
}

// HandleSetAudioLangPrefs — PUT /api/v1/local-library/audio-langs
// Body: {"default":"fre","anime":"jpn"} (ISO 639-2 codes).
func (h *Handler) HandleSetAudioLangPrefs(c echo.Context) error {
	var body struct {
		Default string `json:"default"`
		Anime   string `json:"anime"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	if err := h.App.ApplyAudioLangPrefs(body.Default, body.Anime); err != nil {
		return RespondErr(c, err)
	}
	def, anime := h.App.AudioLangPrefs()
	return RespondOK(c, map[string]any{
		"default": def,
		"anime":   anime,
	})
}

// HandleConvertMKVs — POST /api/v1/local-library/convert
//
// Kicks off a batch that walks every .mkv row in the DB, remuxes it
// to .mp4 (transcoding the audio to AAC if needed), and deletes the
// .mkv on success. Returns 202 immediately; the frontend polls
// /convert/status to render a progress bar. 409 if a batch is
// already running.
func (h *Handler) HandleConvertMKVs(c echo.Context) error {
	if h.App.Config.Library.Dir == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "library dir not configured",
		})
	}
	if !library.TryStartConvertBatch(h.App.Database, h.App.NewAudioLangPicker()) {
		return c.JSON(http.StatusConflict, map[string]any{
			"error": "conversion already running",
		})
	}
	return c.JSON(http.StatusAccepted, map[string]any{"started": true})
}

// HandleConvertStatus — GET /api/v1/local-library/convert/status
//
// Returns the live progress of the current batch (or the final
// summary of the last finished batch). Polled by the settings UI
// while the batch is running.
func (h *Handler) HandleConvertStatus(c echo.Context) error {
	return RespondOK(c, library.ConvertSnapshot())
}

// HandleConvertCancel — POST /api/v1/local-library/convert/cancel
//
// Stops the current batch. The in-flight ffmpeg is killed via context
// cancellation, leaving its (incomplete) .mp4 cleaned up.
func (h *Handler) HandleConvertCancel(c echo.Context) error {
	library.CancelConvertBatch()
	return RespondOK(c, map[string]any{"cancelled": true})
}

// HandleReorderAudio — POST /api/v1/local-library/reorder-audio
//
// Re-runs the audio-track ordering pass against every .mp4 already
// in the library. Lightweight: -c copy + new -map order, ~seconds
// per file. Useful when the user changes the preferred audio
// language settings AFTER having already converted their library.
//
// 409 when a convert / reorder batch is already running.
func (h *Handler) HandleReorderAudio(c echo.Context) error {
	if !library.TryStartReorderBatch(h.App.Database, h.App.NewAudioLangPicker()) {
		return c.JSON(http.StatusConflict, map[string]any{
			"error": "another batch is already running",
		})
	}
	return c.JSON(http.StatusAccepted, map[string]any{"started": true})
}

// -----------------------------------------------------------------------------
// Subtitles — probe + on-demand VTT extraction
// -----------------------------------------------------------------------------
//
// Local MKV / MP4 files often ship embedded subtitle tracks (VF, EN,
// commentary…). The browser can't render SRT/ASS/PGS natively, so we
// expose two endpoints:
//
//   GET /api/v1/local-library/probe/:id
//       → JSON { duration, subtitles: [{streamIndex, lang, codec, title}] }
//
//   GET /api/v1/local-library/subtitle/:id/:streamIdx.vtt
//       → text/vtt, extracted on demand via ffmpeg
//
// The frontend probes once, renders a "Sous-titres" menu in the
// player, attaches a <track> per chosen subtitle. ffmpeg converts
// most text-based formats (subrip, ass, mov_text) cleanly to WebVTT.
// PGS (bitmap subs from Blu-rays) won't work — they need OCR.
//
// Audio tracks intentionally not exposed: switching audio via
// server-side re-mux re-introduced the drift / freeze issues we just
// killed by reverting to direct file streaming. On Safari, the
// native controls expose multi-audio anyway.

type localSubTrack struct {
	StreamIndex int    `json:"streamIndex"` // stream index in the subtitle list (0, 1, 2…)
	Lang        string `json:"lang,omitempty"`
	Codec       string `json:"codec,omitempty"`
	Title       string `json:"title,omitempty"`
}

type localAudioTrack struct {
	StreamIndex int    `json:"streamIndex"` // 0-based among audio streams
	Lang        string `json:"lang,omitempty"`
	Codec       string `json:"codec,omitempty"`
	Title       string `json:"title,omitempty"`
}

type localProbeResp struct {
	Duration  float64           `json:"duration"`
	// IsAnime reflects the TMDB-driven classifier (genre 16 +
	// original_language=ja). The player uses it to auto-activate
	// the French subtitle track when the user is watching the
	// VO of an anime.
	IsAnime   bool              `json:"isAnime"`
	Audio     []localAudioTrack `json:"audio,omitempty"`
	Subtitles []localSubTrack   `json:"subtitles,omitempty"`
}

// HandleProbeLocalFile — GET /api/v1/local-library/probe/:id
func (h *Handler) HandleProbeLocalFile(c echo.Context) error {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		return c.NoContent(http.StatusBadRequest)
	}
	absFile, errResp := h.resolveLocalFilePath(c, uint(id))
	if errResp != nil {
		return errResp
	}

	// One ffprobe call gets us duration + all stream metadata.
	ctx, cancel := context.WithTimeout(c.Request().Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-show_entries", "format=duration:stream=index,codec_type,codec_name:stream_tags=language,title",
		"-of", "json",
		absFile,
	)
	out, err := cmd.Output()
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]any{
			"error": "ffprobe failed: " + err.Error(),
		})
	}

	resp := localProbeResp{
		Audio:     []localAudioTrack{},
		Subtitles: []localSubTrack{},
	}
	// Compute the anime flag from the LocalFile row — drives the
	// frontend's auto-activate-FR-subtitles behaviour.
	if f, err := h.App.Database.GetLocalFile(uint(id)); err == nil && f != nil {
		resp.IsAnime = h.App.IsAnime(f.MediaType, f.TMDBID)
	}
	var probe struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Index     int    `json:"index"`
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Tags      struct {
				Language string `json:"language"`
				Title    string `json:"title"`
			} `json:"tags"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]any{
			"error": "ffprobe parse: " + err.Error(),
		})
	}
	if d, err := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64); err == nil {
		resp.Duration = d
	}
	subIdx, audioIdx := 0, 0
	for _, s := range probe.Streams {
		switch s.CodecType {
		case "subtitle":
			resp.Subtitles = append(resp.Subtitles, localSubTrack{
				StreamIndex: subIdx,
				Lang:        s.Tags.Language,
				Codec:       s.CodecName,
				Title:       s.Tags.Title,
			})
			subIdx++
		case "audio":
			resp.Audio = append(resp.Audio, localAudioTrack{
				StreamIndex: audioIdx,
				Lang:        s.Tags.Language,
				Codec:       s.CodecName,
				Title:       s.Tags.Title,
			})
			audioIdx++
		}
	}
	return RespondOK(c, resp)
}

// HandleExtractSubtitle — GET /api/v1/local-library/subtitle/:id/:idx.vtt
//
// Pipes ffmpeg output for one subtitle stream directly to the
// response. Text-based subs (subrip, ass, mov_text) convert cleanly
// to WebVTT. PGS / DVD bitmap subs are skipped server-side; the
// frontend should treat 422 as "not extractable".
func (h *Handler) HandleExtractSubtitle(c echo.Context) error {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		return c.NoContent(http.StatusBadRequest)
	}
	idxStr := strings.TrimSuffix(c.Param("idx"), ".vtt")
	idx, err := strconv.Atoi(idxStr)
	if err != nil || idx < 0 {
		return c.NoContent(http.StatusBadRequest)
	}
	absFile, errResp := h.resolveLocalFilePath(c, uint(id))
	if errResp != nil {
		return errResp
	}

	c.Response().Header().Set("Content-Type", "text/vtt; charset=utf-8")
	c.Response().Header().Set("Cache-Control", "private, max-age=3600")
	c.Response().WriteHeader(http.StatusOK)

	ctx := c.Request().Context()
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "error",
		"-i", absFile,
		"-map", fmt.Sprintf("0:s:%d", idx),
		"-c:s", "webvtt",
		"-f", "webvtt",
		"pipe:1",
	)
	cmd.Stdout = c.Response().Writer
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("subtitle extract %d/%d: %v | %s",
			id, idx, err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// HandleImportTorrent — POST /api/v1/local-library/import-torrent
//
// Multipart form: field "torrent" = the .torrent file bytes.
//
// Flow :
//   1. Push the .torrent to TorBox (AddTorrentFile)
//   2. Poll until ready (90 s budget)
//   3. For each video file in the torrent :
//        - parse the filename + match TMDB (reuses scanner logic)
//        - upsert a LocalFile row with source="torbox",
//          path="torbox://<torrentId>/<fileId>"
//   4. Return summary { imported, skipped, errors }
//
// The frontend then refreshes /local-library and the new entries
// appear in the home rail alongside on-disk files. Playback goes
// through /resolve-stream/:id which materialises the TorBox URL
// on demand (those URLs expire so we don't cache them).
func (h *Handler) HandleImportTorrent(c echo.Context) error {
	fh, err := c.FormFile("torrent")
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "missing form field 'torrent' (.torrent file)",
		})
	}
	if !strings.HasSuffix(strings.ToLower(fh.Filename), ".torrent") {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "expected a .torrent file",
		})
	}
	src, err := fh.Open()
	if err != nil {
		return RespondErr(c, err)
	}
	defer src.Close()
	content, err := io.ReadAll(src)
	if err != nil {
		return RespondErr(c, err)
	}

	ctx := c.Request().Context()
	result, err := library.ImportTorrentFromBytes(
		ctx, content, fh.Filename, h.App.TorBox, h.App.Database, h.App.TMDB,
	)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{
			"error": err.Error(),
		})
	}
	return RespondOK(c, result)
}

// HandleResolveStream — POST /api/v1/local-library/resolve-stream/:id
//
// For "torbox" sources, request a fresh streamable URL from TorBox
// (those URLs expire so we don't cache them in the DB), then probe
// duration + codecs + subtitles like the regular Play handler does.
// Returns the same shape as /torbox/play so the frontend can stash
// it for /watch?customStream=1.
//
// For "local" sources, returns 400 — the frontend should hit
// /local-library/stream/:id directly instead (HTTP Range native).
func (h *Handler) HandleResolveStream(c echo.Context) error {
	id64, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		return c.NoContent(http.StatusBadRequest)
	}
	f, err := h.App.Database.GetLocalFile(uint(id64))
	if err != nil {
		return c.NoContent(http.StatusNotFound)
	}
	if f.Source != "torbox" {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "resolve-stream is only for source=torbox; use /stream/:id for local files",
		})
	}
	if f.TorrentID <= 0 {
		return c.JSON(http.StatusUnprocessableEntity, map[string]any{
			"error": "torbox row missing TorrentID",
		})
	}

	ctx := c.Request().Context()
	streamURL, err := h.App.TorBox.RequestDownloadURL(ctx, f.TorrentID, f.TorrentFileID)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{
			"error": "TorBox: " + err.Error(),
		})
	}
	probe := probeMediaResult(ctx, streamURL)
	return RespondOK(c, map[string]any{
		"streamUrl":   streamURL,
		"torrentId":   f.TorrentID,
		"fileId":      f.TorrentFileID,
		"audioCodec":  probe.AudioCodec,
		"videoCodec":  probe.VideoCodec,
		"container":   probe.Container,
		"durationSec": probe.Duration,
		"subtitles":   probe.Subtitles,
	})
}

// HandleMatchLocalFile — POST /api/v1/local-library/match/:id
//
// Body: { "tmdbId": <int>, "mediaType": "tv"|"movie" }
//
// Re-fetches TMDB metadata for the given id+type and updates the
// LocalFile row in place. Used by the "ce n'est pas le bon match"
// flow: when the auto-scan matched the wrong title (eg. Spider-Man
// 1994 → Spider-Man 2003 because of name collision), the admin picks
// the correct title from a search and we patch the row.
func (h *Handler) HandleMatchLocalFile(c echo.Context) error {
	id64, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		return c.NoContent(http.StatusBadRequest)
	}
	id := uint(id64)

	var body struct {
		TMDBID    int    `json:"tmdbId"`
		MediaType string `json:"mediaType"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	if body.TMDBID <= 0 {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "tmdbId is required and must be > 0",
		})
	}
	if body.MediaType != "tv" && body.MediaType != "movie" {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "mediaType must be 'tv' or 'movie'",
		})
	}

	f, err := h.App.Database.GetLocalFile(id)
	if err != nil {
		return c.NoContent(http.StatusNotFound)
	}

	// Fetch the new metadata from TMDB. Same JSON shape as the
	// detail endpoint; we only pull the fields we store on the row.
	var path string
	if body.MediaType == "tv" {
		path = fmt.Sprintf("/tv/%d", body.TMDBID)
	} else {
		path = fmt.Sprintf("/movie/%d", body.TMDBID)
	}
	var data struct {
		Title        string `json:"title"`         // movie
		Name         string `json:"name"`          // tv
		Overview     string `json:"overview"`
		PosterPath   string `json:"poster_path"`
		BackdropPath string `json:"backdrop_path"`
		ReleaseDate  string `json:"release_date"`   // movie
		FirstAirDate string `json:"first_air_date"` // tv
	}
	ctx, cancel := context.WithTimeout(c.Request().Context(), 10*time.Second)
	defer cancel()
	if err := h.App.TMDB.GetJSON(ctx, path, nil, &data); err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{
			"error": "TMDB fetch failed: " + err.Error(),
		})
	}

	title := data.Title
	if title == "" {
		title = data.Name
	}
	dateStr := data.ReleaseDate
	if dateStr == "" {
		dateStr = data.FirstAirDate
	}
	year := 0
	if len(dateStr) >= 4 {
		year, _ = strconv.Atoi(dateStr[:4])
	}

	f.TMDBID = body.TMDBID
	f.MediaType = body.MediaType
	f.Title = title
	f.Overview = data.Overview
	f.PosterPath = data.PosterPath
	f.BackdropPath = data.BackdropPath
	if year > 0 {
		f.Year = year
	}

	updated, err := h.App.Database.UpsertLocalFile(f)
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, updated)
}

// resolveLocalFilePath looks up the LocalFile row, security-checks
// it's still under the configured library dir, and returns the
// absolute file path. On any failure returns an *echo.Response error
// the caller should return verbatim.
func (h *Handler) resolveLocalFilePath(c echo.Context, id uint) (string, error) {
	f, err := h.App.Database.GetLocalFile(id)
	if err != nil {
		return "", c.NoContent(http.StatusNotFound)
	}
	configuredDir := strings.TrimSpace(h.App.Config.Library.Dir)
	if configuredDir == "" {
		return "", c.JSON(http.StatusServiceUnavailable, map[string]any{
			"error": "library dir not configured",
		})
	}
	absDir, _ := filepath.Abs(configuredDir)
	absFile, _ := filepath.Abs(f.Path)
	rel, err := filepath.Rel(absDir, absFile)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", c.JSON(http.StatusForbidden, map[string]any{
			"error": "file outside configured library dir",
		})
	}
	if _, err := os.Stat(absFile); err != nil {
		return "", c.JSON(http.StatusNotFound, map[string]any{
			"error": "file no longer exists on disk",
		})
	}
	return absFile, nil
}

// Compile-time link check: ensure core.SettingLibraryDir is exported
// at the expected name (we reference it via the App helper above).
var _ = core.SettingLibraryDir
