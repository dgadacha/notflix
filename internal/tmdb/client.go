// Package tmdb is a thin wrapper around The Movie Database API.
//
// We don't model every field TMDB returns — the backend forwards JSON
// payloads almost untouched (so the frontend talks to TMDB's schema
// directly, which is well documented). The Go side mostly exists to
// keep the API key off the browser and add a 30 s response cache to
// stay friendly with TMDB's rate limit.
package tmdb

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

const (
	baseURL      = "https://api.themoviedb.org/3"
	imageBaseURL = "https://image.tmdb.org/t/p"
	defaultLang  = "fr-FR" // FR-first, matches Kuro
)

type Client struct {
	apiKey string
	http   *http.Client

	mu    sync.RWMutex
	cache map[string]cachedResponse
}

type cachedResponse struct {
	body      []byte
	expiresAt time.Time
}

func NewClient(apiKey string) *Client {
	return &Client{
		apiKey: apiKey,
		http: &http.Client{
			Timeout: 15 * time.Second,
		},
		cache: make(map[string]cachedResponse),
	}
}

func (c *Client) HasKey() bool { return c.apiKey != "" }

// Get hits TMDB with the given path + extra query params, returns the raw
// JSON body. 30 s TTL cache keyed by full URL — discover endpoints get hit
// multiple times per session (one per row on the home page) and they
// barely change, so caching is a huge net win.
func (c *Client) Get(ctx context.Context, path string, params url.Values) ([]byte, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("tmdb: API key not configured (NOTFLIX_TMDB_API_KEY)")
	}

	q := url.Values{}
	for k, v := range params {
		q[k] = v
	}
	q.Set("api_key", c.apiKey)
	if q.Get("language") == "" {
		q.Set("language", defaultLang)
	}
	fullURL := baseURL + path + "?" + q.Encode()

	// Cache lookup — use the URL (with key + lang) as the key so changing
	// either invalidates naturally.
	c.mu.RLock()
	if cached, ok := c.cache[fullURL]; ok && time.Now().Before(cached.expiresAt) {
		c.mu.RUnlock()
		return cached.body, nil
	}
	c.mu.RUnlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		// Surface the TMDB error message verbatim — saves a debug round-trip.
		return nil, fmt.Errorf("tmdb %d: %s", res.StatusCode, string(body))
	}

	c.mu.Lock()
	c.cache[fullURL] = cachedResponse{body: body, expiresAt: time.Now().Add(30 * time.Second)}
	c.mu.Unlock()
	return body, nil
}

// GetJSON is a convenience wrapper that unmarshals into the caller's struct.
func (c *Client) GetJSON(ctx context.Context, path string, params url.Values, out any) error {
	body, err := c.Get(ctx, path, params)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

// ImageURL builds a CDN URL for a TMDB image path. Use sizes like:
//
//	"w185"  / "w342"  / "w500"  / "w780"  — poster
//	"w1280" / "original"                   — backdrop
func ImageURL(size, path string) string {
	if path == "" {
		return ""
	}
	return imageBaseURL + "/" + size + path
}
