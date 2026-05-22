package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

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
// Three cache tiers:
//   - In-memory 30 s LRU (tmdb.Client.Get) absorbs hot bursts.
//   - SQLite tmdb_cache_entries — persistent across restarts, TTL
//     varies by path (see tmdbCacheTTL).
//   - HTTP upstream when both miss.
//
// Detail pages (movie / tv / credits / videos) are cached for 7 days
// because they change very rarely. Trending / popular / discover for 6 h.
// Search results for 1 h. Configuration for 30 days.
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

	// SQLite cache lookup. Key is path + sorted(params) — sorting makes
	// the hash stable regardless of param insertion order.
	cacheKey := tmdbCacheKey(tmdbPath, params)
	if cached := h.App.Database.GetTMDBCache(cacheKey); cached != nil {
		c.Response().Header().Set("X-TMDB-Source", "cache:sqlite")
		return c.Blob(http.StatusOK, "application/json", cached)
	}

	body, err := h.App.TMDB.Get(c.Request().Context(), tmdbPath, params)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{"error": err.Error()})
	}

	// Persist for future requests. Path-driven TTL.
	ttl := tmdbCacheTTL(tmdbPath)
	if ttl > 0 {
		if err := h.App.Database.PutTMDBCache(cacheKey, tmdbPath, body, time.Now().Add(ttl)); err != nil {
			// Non-fatal — fall through and return the body.
			log.Printf("tmdb cache: put failed for %s: %v", tmdbPath, err)
		}
	}

	c.Response().Header().Set("X-TMDB-Source", "upstream")
	return c.Blob(http.StatusOK, "application/json", body)
}

// tmdbCacheKey deterministically hashes (path, params) into a 64-hex
// SHA-256 string. Param keys are sorted so two requests with the same
// params land at the same key regardless of insertion order.
func tmdbCacheKey(path string, params map[string][]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	b.WriteString(path)
	for _, k := range keys {
		b.WriteByte('|')
		b.WriteString(k)
		b.WriteByte('=')
		// Param values are slices; join with comma for stable hashing.
		b.WriteString(strings.Join(params[k], ","))
	}
	digest := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(digest[:])
}

// tmdbCacheTTL picks a cache lifetime for the given path. Pure-data
// endpoints (movie/tv detail, configuration) get long TTLs; dynamic
// endpoints (search, trending) short TTLs.
//
// Return 0 to skip caching.
func tmdbCacheTTL(path string) time.Duration {
	switch {
	case strings.HasPrefix(path, "/configuration"):
		// Configuration changes maybe twice a year. 30 d is plenty.
		return 30 * 24 * time.Hour

	case strings.HasPrefix(path, "/genre/"):
		// Genre lists are nearly static.
		return 30 * 24 * time.Hour

	case strings.Contains(path, "/credits") ||
		strings.Contains(path, "/videos") ||
		strings.Contains(path, "/recommendations") ||
		strings.Contains(path, "/similar") ||
		strings.Contains(path, "/external_ids"):
		// Detail sub-resources — change rarely.
		return 7 * 24 * time.Hour

	case strings.HasPrefix(path, "/movie/") ||
		strings.HasPrefix(path, "/tv/") ||
		strings.HasPrefix(path, "/person/"):
		// Top-level detail pages.
		return 7 * 24 * time.Hour

	case strings.HasPrefix(path, "/search/"):
		// Search results need to be relatively fresh — 1 h gives just
		// enough to absorb back-button traffic without going stale.
		return 1 * time.Hour

	case strings.HasPrefix(path, "/trending/") ||
		strings.Contains(path, "/popular") ||
		strings.Contains(path, "/top_rated") ||
		strings.Contains(path, "/upcoming") ||
		strings.Contains(path, "/now_playing") ||
		strings.HasPrefix(path, "/discover/"):
		// Browse rows — TMDB refreshes these a couple of times a day.
		return 6 * time.Hour

	default:
		return 1 * time.Hour
	}
}
