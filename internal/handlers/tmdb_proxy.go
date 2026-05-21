package handlers

import (
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

// HandleTMDBProxy forwards a GET request to TMDB transparently, with the API
// key injected server-side. Frontend calls `/api/v1/tmdb/<tmdb-path>` exactly
// as it would call `https://api.themoviedb.org/3/<tmdb-path>`.
//
// Examples:
//
//	GET /api/v1/tmdb/trending/movie/week
//	GET /api/v1/tmdb/movie/603692?append_to_response=credits,videos
//	GET /api/v1/tmdb/search/movie?query=inception
//
// The 30s cache in tmdb.Client absorbs repeat calls (each row on the home
// page typically generates the same handful of URLs over and over).
func (h *Handler) HandleTMDBProxy(c echo.Context) error {
	if !h.App.TMDB.HasKey() {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "TMDB API key not configured. Set NOTFLIX_TMDB_API_KEY then restart.",
		})
	}

	// Strip the /api/v1/tmdb/ prefix to get the upstream path.
	tmdbPath := strings.TrimPrefix(c.Request().URL.Path, "/api/v1/tmdb")
	if !strings.HasPrefix(tmdbPath, "/") {
		tmdbPath = "/" + tmdbPath
	}

	// Forward all query params from the incoming request (except api_key —
	// the TMDB client overrides it anyway).
	params := c.QueryParams()
	params.Del("api_key")

	body, err := h.App.TMDB.Get(c.Request().Context(), tmdbPath, params)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{"error": err.Error()})
	}
	return c.Blob(http.StatusOK, "application/json", body)
}
