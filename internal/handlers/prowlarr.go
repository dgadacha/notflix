package handlers

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"notflix/internal/prowlarr"

	"github.com/labstack/echo/v4"
)

// Prowlarr handlers — expose three endpoints to the frontend:
//
//   GET /api/v1/prowlarr/status                     is Prowlarr reachable?
//   GET /api/v1/prowlarr/search/movie?title=…&year=Y
//   GET /api/v1/prowlarr/search/tv?title=…&season=S&episode=E
//
// Each search call also enriches the result list with TorBox cache state
// for free — saves the frontend an extra round-trip.

func (h *Handler) HandleProwlarrStatus(c echo.Context) error {
	if !h.App.Prowlarr.Configured() {
		return RespondOK(c, map[string]any{"configured": false})
	}
	s, err := h.App.Prowlarr.SystemStatus(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
	}
	indexers, _ := h.App.Prowlarr.ListIndexers(c.Request().Context())
	enabled := 0
	for _, i := range indexers {
		if i.Enable {
			enabled++
		}
	}
	return RespondOK(c, map[string]any{
		"configured":      true,
		"appName":         s.AppName,
		"version":         s.Version,
		"indexerCount":    len(indexers),
		"enabledIndexers": enabled,
	})
}

// HandleSearchMovie — GET /api/v1/prowlarr/search/movie?title=…&year=…
//
// Returns the Prowlarr release list sorted by quality heuristic and
// annotated with TorBox cache status (so the frontend can show ✓ cached
// badges without a second call).
func (h *Handler) HandleSearchMovie(c echo.Context) error {
	title := c.QueryParam("title")
	if title == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "title required"})
	}
	year, _ := strconv.Atoi(c.QueryParam("year"))

	results, err := h.App.Prowlarr.SearchMovie(c.Request().Context(), title, year)
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, h.annotateAndSort(c, results))
}

// HandleSearchTV — GET /api/v1/prowlarr/search/tv?title=…&season=…&episode=…
func (h *Handler) HandleSearchTV(c echo.Context) error {
	title := c.QueryParam("title")
	if title == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "title required"})
	}
	season, _ := strconv.Atoi(c.QueryParam("season"))
	episode, _ := strconv.Atoi(c.QueryParam("episode"))

	results, err := h.App.Prowlarr.SearchTV(c.Request().Context(), title, season, episode)
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, h.annotateAndSort(c, results))
}

// annotateAndSort decorates each search result with cache state and a
// composite score, then sorts by score descending.
func (h *Handler) annotateAndSort(c echo.Context, results []prowlarr.SearchResult) []map[string]any {
	// 1) Collect infohashes to ask TorBox in one batch call.
	hashes := make([]string, 0, len(results))
	for _, r := range results {
		if r.InfoHash != "" {
			hashes = append(hashes, r.InfoHash)
		}
	}
	cached := map[string]bool{}
	if h.App.TorBox.HasKey() && len(hashes) > 0 {
		cached, _ = h.App.TorBox.CheckCached(c.Request().Context(), hashes)
	}

	// 2) Build annotated rows.
	annotated := make([]map[string]any, 0, len(results))
	for _, r := range results {
		isCached := r.InfoHash != "" && cached[strings.ToLower(r.InfoHash)]
		annotated = append(annotated, map[string]any{
			"guid":        r.GUID,
			"title":       r.Title,
			"indexer":     r.Indexer,
			"protocol":    r.Protocol,
			"size":        r.Size,
			"seeders":     r.Seeders,
			"leechers":    r.Leechers,
			"publishDate": r.PublishDate,
			"magnetUrl":   r.MagnetURL,
			"downloadUrl": r.DownloadURL,
			"infoHash":    r.InfoHash,
			"cached":      isCached,
			"quality":     detectQuality(r.Title),
			"score":       scoreRelease(r, isCached),
		})
	}

	// 3) Sort by score desc.
	sort.Slice(annotated, func(i, j int) bool {
		return annotated[i]["score"].(float64) > annotated[j]["score"].(float64)
	})
	return annotated
}

// scoreRelease — heuristic to rank torrent releases.
//
// Priority order:
//  1. Cached on TorBox (= instant playback) — dominant factor
//  2. Number of seeders
//  3. Quality markers in the title (BluRay, 1080p, HEVC, French audio)
//  4. File size sweet spot (1-5 GB for 1080p)
//
// Negative weight on CAMs / telesyncs / oversized remuxes.
func scoreRelease(r prowlarr.SearchResult, cached bool) float64 {
	var score float64
	if cached {
		score += 10000
	}
	score += float64(r.Seeders) * 2
	score -= float64(r.Leechers) / 4
	score += qualityScore(r.Title)

	gb := float64(r.Size) / (1 << 30)
	switch {
	case gb < 0.5:
		score -= 50
	case gb < 5:
		score += 20
	case gb < 15:
		score += 10
	case gb < 40:
		score -= 5
	default:
		score -= 30
	}
	return score
}

func detectQuality(title string) string {
	t := strings.ToLower(title)
	switch {
	case strings.Contains(t, "2160p") || strings.Contains(t, "4k") || strings.Contains(t, "uhd"):
		return "4K"
	case strings.Contains(t, "1080p"):
		return "1080p"
	case strings.Contains(t, "720p"):
		return "720p"
	case strings.Contains(t, "480p") || strings.Contains(t, "dvdrip"):
		return "SD"
	}
	return "?"
}

func qualityScore(title string) float64 {
	t := strings.ToLower(title)
	var s float64
	if strings.Contains(t, "bluray") || strings.Contains(t, "blu-ray") {
		s += 30
	}
	if strings.Contains(t, "remux") {
		s += 20
	}
	if strings.Contains(t, "1080p") {
		s += 25
	} else if strings.Contains(t, "2160p") || strings.Contains(t, "4k") {
		s += 15
	} else if strings.Contains(t, "720p") {
		s += 5
	}
	if strings.Contains(t, "h.265") || strings.Contains(t, "hevc") || strings.Contains(t, "x265") {
		s += 10
	}
	if strings.Contains(t, "multi") || strings.Contains(t, "french") || strings.Contains(t, "vff") {
		s += 40  // bonus for French audio (this is Notflix's audience)
	}
	if strings.Contains(t, "cam") || strings.Contains(t, "ts ") || strings.Contains(t, "telesync") {
		s -= 100
	}
	return s
}
