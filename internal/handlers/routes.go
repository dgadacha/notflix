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

	v1.GET("/status", h.HandleStatus)

	// TMDB proxy — the only place the API key lives.
	v1.GET("/tmdb/*", h.HandleTMDBProxy)

	// TorBox — debrid stream resolution.
	tb := v1.Group("/torbox")
	tb.GET("/status", h.HandleTorBoxStatus)
	tb.POST("/cache", h.HandleTorBoxCheckCached)
	tb.POST("/play", h.HandleTorBoxPlay)
	tb.GET("/list", h.HandleTorBoxList)
	tb.DELETE("/torrent/:id", h.HandleTorBoxDelete)

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
