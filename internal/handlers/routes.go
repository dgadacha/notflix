// Package handlers wires Echo routes to the App service layer.
//
// Route map:
//   /api/v1/status               GET     health + tmdb-key-present flag
//   /api/v1/tmdb/*               GET     transparent proxy to TMDB
//   /api/v1/profiles             GET POST
//   /api/v1/profiles/:uid        PATCH DELETE
//   /api/v1/profiles/:uid/history  GET PUT POST DELETE
//   /api/v1/profiles/:uid/list     GET PUT DELETE
package handlers

import (
	"notflix/internal/core"

	"github.com/labstack/echo/v4"
)

type Handler struct {
	App *core.App
}

func New(app *core.App) *Handler { return &Handler{App: app} }

func RegisterRoutes(e *echo.Echo, h *Handler) {
	v1 := e.Group("/api/v1")

	// Auth middleware fires on every /api/v1/* request. Public
	// endpoints (status, login) are allow-listed inside the middleware.
	v1.Use(h.AuthMiddleware)

	v1.GET("/status", h.HandleStatus)

	// Auth — login is the only un-gated endpoint along with /status.
	auth := v1.Group("/auth")
	auth.POST("/login", h.HandleLogin)
	auth.POST("/logout", h.HandleLogout)
	auth.GET("/me", h.HandleAuthMe)
	auth.POST("/password", h.HandleChangeOwnPassword)

	// Users — admin-only CRUD on child accounts.
	users := v1.Group("/users", h.RequireAdmin)
	users.GET("", h.HandleListUsers)
	users.POST("", h.HandleCreateUser)
	users.DELETE("/:id", h.HandleDeleteUser)
	users.POST("/:id/password", h.HandleResetUserPassword)

	// Admin — server config (TMDB / TorBox / Prowlarr credentials).
	admin := v1.Group("/admin", h.RequireAdmin)
	admin.GET("/config", h.HandleGetServerConfig)
	admin.PUT("/config", h.HandleUpdateServerConfig)
	admin.GET("/backup", h.HandleBackupExport)
	admin.POST("/backup/restore", h.HandleBackupRestore)
	admin.POST("/test/:provider", h.HandleTestProvider)

	// TMDB image cache — disk-backed proxy for image.tmdb.org so posters,
	// backdrops and stills are served at LAN speed and survive browser
	// cache evictions. Registered BEFORE the catch-all /tmdb/* so the
	// /tmdb/img/<size>/<path> shape doesn't get swallowed by the JSON
	// proxy.
	v1.GET("/tmdb/img/:size/*", h.HandleTMDBImage)

	// TMDB JSON proxy — the only place the API key lives.
	v1.GET("/tmdb/*", h.HandleTMDBProxy)

	// TorBox — debrid stream resolution.
	tb := v1.Group("/torbox")
	tb.GET("/status", h.HandleTorBoxStatus)
	tb.POST("/cache", h.HandleTorBoxCheckCached)
	tb.POST("/play", h.HandleTorBoxPlay)
	tb.POST("/prefetch", h.HandleTorBoxPrefetch)
	tb.GET("/list", h.HandleTorBoxList)
	tb.DELETE("/torrent/:id", h.HandleTorBoxDelete)

	// Prowlarr — torrent indexer aggregator (search → list of magnets,
	// annotated with TorBox cache state).
	pr := v1.Group("/prowlarr")
	pr.GET("/status", h.HandleProwlarrStatus)
	pr.GET("/health", h.HandleProwlarrHealth)
	pr.GET("/search/movie", h.HandleSearchMovie)
	pr.GET("/search/tv", h.HandleSearchTV)

	// Local library — scan a host directory, match files against TMDB,
	// stream them with HTTP Range. Stream is open to any logged-in
	// user; mutations (set dir, trigger scan, list-all incl. orphans)
	// are admin-gated.
	lib := v1.Group("/local-library")
	lib.GET("", h.HandleListLocalLibrary)
	lib.GET("/stream/:id", h.HandleStreamLocalFile)
	// Subtitle support: probe surfaces the embedded subtitle tracks,
	// /subtitle/:id/:idx.vtt extracts one of them via ffmpeg.
	lib.GET("/probe/:id", h.HandleProbeLocalFile)
	lib.GET("/subtitle/:id/:idx", h.HandleExtractSubtitle)
	// SSE stream — pushes "a new file landed in your library" events
	// to every logged-in browser. Doesn't need admin: the toast is
	// useful for all viewers (even if only the admin can trigger scans).
	lib.GET("/events", h.HandleLibraryEvents)
	libAdmin := v1.Group("/local-library", h.RequireAdmin)
	libAdmin.GET("/all", h.HandleListAllLocalFiles)
	libAdmin.GET("/dir", h.HandleGetLibraryDir)
	libAdmin.PUT("/dir", h.HandleSetLibraryDir)
	libAdmin.POST("/scan", h.HandleScanLocalLibrary)
	libAdmin.GET("/scan/status", h.HandleScanStatus)
	// MKV → MP4 batch conversion. Runs ffmpeg per MKV row in the DB,
	// remuxing video bit-perfect and transcoding audio to AAC when
	// the source isn't already AAC. Deletes the source on success.
	libAdmin.POST("/convert", h.HandleConvertMKVs)
	libAdmin.GET("/convert/status", h.HandleConvertStatus)
	libAdmin.POST("/convert/cancel", h.HandleConvertCancel)
	// Auto-convert toggle: when ON, each successful scan chain-
	// triggers the batch converter (no-op if a batch is already
	// running, so back-to-back scans don't stack jobs).
	libAdmin.GET("/auto-convert", h.HandleGetAutoConvert)
	libAdmin.PUT("/auto-convert", h.HandleSetAutoConvert)
	// Preferred audio language pair (default + anime). The converter
	// reorders MP4 audio tracks so the preferred language lands at
	// track 0 → browsers play it first without any client switching.
	libAdmin.GET("/audio-langs", h.HandleGetAudioLangPrefs)
	libAdmin.PUT("/audio-langs", h.HandleSetAudioLangPrefs)

	// Stream transmux — pipes a TorBox URL through ffmpeg to swap the
	// audio codec for AAC. Used as a fallback when the browser can't
	// decode the source audio (DDP / DTS / TrueHD on non-Apple Chrome).
	//
	// Two flavours:
	//   - /transmux : raw matroska pipe, no seek (legacy, simpler)
	//   - /hls/*    : HLS chunked playlist, full seek bar support
	s := v1.Group("/stream")
	s.GET("/transmux", h.HandleStreamTransmux)
	s.POST("/hls/start", h.HandleStreamHLSStart)
	// Subtitle prep — POST kicks off the extraction/translation
	// of the user's preferred subtitle for an HLS session. GET
	// returns the live status the watch page polls every ~1 s.
	s.POST("/hls/:sessionId/prep", h.HandleSubPrepStart)
	s.GET("/hls/:sessionId/prep", h.HandleSubPrepStatus)
	s.GET("/hls/:sessionId/*", h.HandleStreamHLSFile)

	// Profiles
	p := v1.Group("/profiles")
	p.GET("", h.HandleListProfiles)
	p.POST("", h.HandleCreateProfile)
	p.PATCH("/:uid", h.HandleUpdateProfile)
	p.DELETE("/:uid", h.HandleDeleteProfile)

	// Watch history
	p.GET("/:uid/history", h.HandleListHistory)
	p.PUT("/:uid/history", h.HandleUpsertHistory)
	p.POST("/:uid/history", h.HandleUpsertHistory) // sendBeacon-compatible alias
	p.POST("/:uid/history/mark-series", h.HandleMarkSeriesWatched)
	p.DELETE("/:uid/history", h.HandleClearHistory)
	p.DELETE("/:uid/history/:mediaType/:tmdbId", h.HandleDeleteHistoryByMedia)

	// Profile list
	p.GET("/:uid/list", h.HandleListProfileList)
	p.PUT("/:uid/list", h.HandleUpsertProfileList)
	p.DELETE("/:uid/list/:mediaType/:tmdbId", h.HandleDeleteProfileListEntry)
}

// RespondOK wraps the response payload in {"data": ...} for consistency.
func RespondOK(c echo.Context, data any) error {
	return c.JSON(200, map[string]any{"data": data})
}

func RespondErr(c echo.Context, err error) error {
	return c.JSON(500, map[string]any{"error": err.Error()})
}
