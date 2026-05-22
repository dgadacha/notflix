package handlers

import "github.com/labstack/echo/v4"

func (h *Handler) HandleStatus(c echo.Context) error {
	return RespondOK(c, map[string]any{
		"app":         "notflix",
		"version":     "0.1.0",
		"tmdbKeySet":  h.App.TMDB.HasKey(),
		"datadir":     h.App.Config.Data.Dir,
	})
}
