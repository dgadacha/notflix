package handlers

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
)

// HandleTMDBImage — GET /api/v1/tmdb/img/:size/*path
//
// Caches TMDB images on local disk so they're served at LAN speed and
// survive browser cache evictions. On a cold cache it proxies the
// request to image.tmdb.org, tees the bytes into a temp file, atomically
// renames into the cache, and serves the response. On a warm cache the
// file is served directly from disk with a long Cache-Control so the
// browser caches it aggressively too.
//
// Cache layout: <datadir>/cache/tmdb-img/<size>/<basename>.
// E.g. ~/.notflix-data/cache/tmdb-img/w780/9eEMQfBGsvNwoLkqkRBOaeDXf6F.jpg
//
// TMDB image URLs are content-addressed (the path includes a sha-like
// id), so files are immutable — `Cache-Control: max-age=31536000,
// immutable` is safe.

// validImageSizes — the full set documented at
// https://developer.themoviedb.org/reference/configuration-details.
//
//   Posters    : w92, w154, w185, w342, w500, w780, original
//   Backdrops  : w300, w780, w1280, original
//   Stills     : w92, w185, w300, original  ← episode thumbnails live here
//   Logos      : w45, w92, w154, w185, w300, w500, original
//   Profiles   : w45, w185, h632, original
//
// We accept the union so any TMDB image path the frontend asks for goes
// through the cache. Forgetting w300 silently broke the episode-thumbnail
// rendering after Phase 4.4 — the handler was returning 400 and the UI
// rendered the empty-placeholder branch with no obvious clue why.
var validImageSizes = map[string]bool{
	"w45": true, "w92": true, "w154": true, "w185": true, "w300": true,
	"w342": true, "w500": true, "w780": true, "w1280": true,
	"h632": true, "original": true,
}

func (h *Handler) HandleTMDBImage(c echo.Context) error {
	size := c.Param("size")
	rest := c.Param("*")
	if size == "" || rest == "" {
		return c.NoContent(http.StatusBadRequest)
	}
	if !validImageSizes[size] {
		return c.NoContent(http.StatusBadRequest)
	}

	// Sanitise the rest of the path — TMDB ids are alphanumerics +
	// dots, no slashes inside. Block path traversal.
	if strings.ContainsAny(rest, "/\\") || strings.Contains(rest, "..") {
		return c.NoContent(http.StatusBadRequest)
	}

	cacheDir := filepath.Join(h.App.Config.Data.Dir, "cache", "tmdb-img", size)
	cachePath := filepath.Join(cacheDir, rest)

	// Warm cache — serve from disk.
	if info, err := os.Stat(cachePath); err == nil && info.Size() > 0 {
		setImageCacheHeaders(c, "HIT", rest)
		return c.File(cachePath)
	}

	// Cold cache — fetch from TMDB.
	upstream := "https://image.tmdb.org/t/p/" + size + "/" + rest
	if u, err := url.Parse(upstream); err != nil || u.Host == "" {
		return c.NoContent(http.StatusBadRequest)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Get(upstream)
	if err != nil {
		return c.NoContent(http.StatusBadGateway)
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return c.NoContent(res.StatusCode)
	}

	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		// If we can't write to disk, still serve the response.
		setImageCacheHeaders(c, "MISS-NOCACHE", rest)
		c.Response().Header().Set("Content-Type", res.Header.Get("Content-Type"))
		_, err := io.Copy(c.Response().Writer, res.Body)
		return err
	}

	// Tee the body into both the response and a temp file. Atomic
	// rename on success keeps the cache consistent if the connection
	// drops mid-download.
	tmpPath := cachePath + ".tmp"
	tmp, err := os.Create(tmpPath)
	if err != nil {
		setImageCacheHeaders(c, "MISS-NOCACHE", rest)
		c.Response().Header().Set("Content-Type", res.Header.Get("Content-Type"))
		_, copyErr := io.Copy(c.Response().Writer, res.Body)
		return copyErr
	}
	defer func() {
		tmp.Close()
		_ = os.Remove(tmpPath) // no-op if rename already moved it
	}()

	setImageCacheHeaders(c, "MISS", rest)
	c.Response().Header().Set("Content-Type", res.Header.Get("Content-Type"))
	mw := io.MultiWriter(c.Response().Writer, tmp)
	if _, err := io.Copy(mw, res.Body); err != nil {
		return err
	}
	tmp.Close()
	_ = os.Rename(tmpPath, cachePath)
	return nil
}

func setImageCacheHeaders(c echo.Context, cacheStatus, name string) {
	// 1 year, immutable. TMDB image paths are content-addressed.
	c.Response().Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	c.Response().Header().Set("X-Cache", cacheStatus)
	c.Response().Header().Set("Vary", "Accept")
	// Best-effort content type hint when we know the extension.
	switch {
	case strings.HasSuffix(strings.ToLower(name), ".jpg"),
		strings.HasSuffix(strings.ToLower(name), ".jpeg"):
		c.Response().Header().Set("Content-Type", "image/jpeg")
	case strings.HasSuffix(strings.ToLower(name), ".png"):
		c.Response().Header().Set("Content-Type", "image/png")
	case strings.HasSuffix(strings.ToLower(name), ".webp"):
		c.Response().Header().Set("Content-Type", "image/webp")
	}
}
