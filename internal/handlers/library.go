package handlers

import (
	"context"
	"log"
	"net/http"
	"os"
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

// One scan at a time, process-wide. Concurrent POSTs are coalesced;
// the second caller gets a 409 instead of stepping on the first.
// lastReport is the most recent finished scan, exposed by /scan/status.
var (
	scanMu     sync.Mutex
	scanInFlight bool
	scanFlightMu sync.Mutex
	lastReport *library.ScanReport
)

func tryAcquireScan() bool {
	scanFlightMu.Lock()
	defer scanFlightMu.Unlock()
	if scanInFlight {
		return false
	}
	scanInFlight = true
	return true
}

func releaseScan() {
	scanFlightMu.Lock()
	scanInFlight = false
	scanFlightMu.Unlock()
}

// HandleScanLocalLibrary — POST /api/v1/local-library/scan
//
// Synchronous on purpose. With TMDB SQLite cache hits, a typical
// 200-file library scans in 5-20 s — well within an HTTP request
// budget and the UI can show a clear "Scan en cours…" spinner.
//
// 409 when a scan is already running. Frontend polls /scan/status if
// it needs progress / report after a 409.
func (h *Handler) HandleScanLocalLibrary(c echo.Context) error {
	dir := h.App.Config.Library.Dir
	if dir == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "library dir not configured — set it first via PUT /local-library/dir",
		})
	}

	if !tryAcquireScan() {
		return c.JSON(http.StatusConflict, map[string]any{
			"error": "scan already in progress",
		})
	}
	defer releaseScan()

	// Serialise the actual TMDB calls + DB writes so we don't blow
	// the rate limit on rapid double-clicks.
	scanMu.Lock()
	defer scanMu.Unlock()

	ctx, cancel := context.WithTimeout(c.Request().Context(), 10*time.Minute)
	defer cancel()

	rep, err := library.Scan(ctx, dir, h.App.TMDB, h.App.Database)
	if err != nil {
		log.Printf("library scan: %v", err)
		return c.JSON(http.StatusBadGateway, map[string]any{
			"error":  err.Error(),
			"report": rep,
		})
	}
	lastReport = rep
	return RespondOK(c, rep)
}

// HandleScanStatus — GET /api/v1/local-library/scan/status
//
// Returns the last finished scan report + whether a scan is
// currently running. The UI uses this to render a "last scan: X min
// ago" line.
func (h *Handler) HandleScanStatus(c echo.Context) error {
	scanFlightMu.Lock()
	running := scanInFlight
	scanFlightMu.Unlock()
	return RespondOK(c, map[string]any{
		"running":    running,
		"lastReport": lastReport,
	})
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

// Compile-time link check: ensure core.SettingLibraryDir is exported
// at the expected name (we reference it via the App helper above).
var _ = core.SettingLibraryDir
