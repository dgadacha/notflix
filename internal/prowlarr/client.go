// Package prowlarr is a thin client for the Prowlarr REST API.
//
// Notflix uses Prowlarr as its torrent indexer aggregator — it talks to
// Prowlarr's unified Search endpoint, gets a list of release candidates
// (with infohashes), then asks TorBox which ones are cached. The user
// picks (or auto-pick best cached) and we play.
//
// Prowlarr API docs: https://prowlarr.com/docs/api
package prowlarr

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Client struct {
	http *http.Client

	mu      sync.RWMutex
	baseURL string
	apiKey  string
}

// NewClient — baseURL is Prowlarr's root (e.g. http://127.0.0.1:9696),
// apiKey from Settings → General → API Key.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// SetConfig hot-swaps both the base URL and the API key. Used by the
// settings UI to apply changes without restarting the binary; the
// release-cache (in handlers/prowlarr.go) keys responses by search
// terms, not by Prowlarr endpoint, so old entries remain coherent.
func (c *Client) SetConfig(baseURL, apiKey string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.baseURL = strings.TrimRight(baseURL, "/")
	c.apiKey = apiKey
}

func (c *Client) currentConfig() (string, string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.baseURL, c.apiKey
}

func (c *Client) Configured() bool {
	baseURL, apiKey := c.currentConfig()
	return baseURL != "" && apiKey != ""
}

func (c *Client) do(ctx context.Context, method, path string, q url.Values, out any) error {
	baseURL, apiKey := c.currentConfig()
	if baseURL == "" || apiKey == "" {
		return fmt.Errorf("prowlarr: not configured (NOTFLIX_PROWLARR_URL + NOTFLIX_PROWLARR_API_KEY)")
	}
	u := baseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Api-Key", apiKey)
	req.Header.Set("Accept", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 {
		return fmt.Errorf("prowlarr %d: %s", res.StatusCode, string(body))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}

// -----------------------------------------------------------------------------
// /api/v1/system/status — health + version (use as a configured-OK check)
// -----------------------------------------------------------------------------

type SystemStatus struct {
	Version   string `json:"version"`
	BuildTime string `json:"buildTime"`
	AppName   string `json:"appName"`
	OsName    string `json:"osName"`
}

func (c *Client) SystemStatus(ctx context.Context) (*SystemStatus, error) {
	var s SystemStatus
	if err := c.do(ctx, http.MethodGet, "/api/v1/system/status", nil, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// -----------------------------------------------------------------------------
// /api/v1/indexer — list configured indexers (for the settings UI)
// -----------------------------------------------------------------------------

type Indexer struct {
	ID                  int    `json:"id"`
	Name                string `json:"name"`
	Enable              bool   `json:"enable"`
	Protocol            string `json:"protocol"`           // "torrent" or "usenet"
	SupportsRss         bool   `json:"supportsRss"`
	SupportsSearch      bool   `json:"supportsSearch"`
	IndexerUrls         []any  `json:"indexerUrls"`
	Priority            int    `json:"priority"`
	DownloadClientID    int    `json:"downloadClientId"`
	Tags                []int  `json:"tags"`
}

func (c *Client) ListIndexers(ctx context.Context) ([]Indexer, error) {
	var arr []Indexer
	if err := c.do(ctx, http.MethodGet, "/api/v1/indexer", nil, &arr); err != nil {
		return nil, err
	}
	return arr, nil
}

// -----------------------------------------------------------------------------
// /api/v1/indexerstats — per-indexer success/failure rolling counts
// -----------------------------------------------------------------------------

// IndexerStat is one row from Prowlarr's stats endpoint. Counts are
// since the rolling window Prowlarr internally tracks (defaults to
// 1 day). Useful for the "is this indexer alive" UI dot.
type IndexerStat struct {
	IndexerID            int    `json:"indexerId"`
	IndexerName          string `json:"indexerName"`
	AverageResponseTime  int    `json:"averageResponseTime"`
	NumberOfQueries      int    `json:"numberOfQueries"`
	NumberOfGrabs        int    `json:"numberOfGrabs"`
	NumberOfRssQueries   int    `json:"numberOfRssQueries"`
	NumberOfAuthQueries  int    `json:"numberOfAuthQueries"`
	NumberOfFailedQueries int   `json:"numberOfFailedQueries"`
	NumberOfFailedGrabs  int    `json:"numberOfFailedGrabs"`
	NumberOfFailedRssQueries int `json:"numberOfFailedRssQueries"`
	NumberOfFailedAuthQueries int `json:"numberOfFailedAuthQueries"`
}

type indexerStatsResponse struct {
	Indexers []IndexerStat `json:"indexers"`
}

func (c *Client) IndexerStats(ctx context.Context) ([]IndexerStat, error) {
	var resp indexerStatsResponse
	if err := c.do(ctx, http.MethodGet, "/api/v1/indexerstats", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Indexers, nil
}

// -----------------------------------------------------------------------------
// /api/v1/search — the main thing Notflix uses
// -----------------------------------------------------------------------------

// SearchResult is one row from /api/v1/search (Torznab-shaped). We only
// model the fields Notflix actually uses; Prowlarr returns ~30 fields per
// row but most are bookkeeping.
type SearchResult struct {
	GUID            string  `json:"guid"`
	Title           string  `json:"title"`
	Indexer         string  `json:"indexer"`
	IndexerID       int     `json:"indexerId"`
	Protocol        string  `json:"protocol"` // "torrent" / "usenet"
	Size            int64   `json:"size"`
	Files           int     `json:"files"`
	Grabs           int     `json:"grabs"`
	Seeders         int     `json:"seeders"`
	Leechers        int     `json:"leechers"`
	PublishDate     string  `json:"publishDate"`
	Categories      []Cat   `json:"categories"`
	DownloadURL     string  `json:"downloadUrl"`
	MagnetURL       string  `json:"magnetUrl"`
	InfoHash        string  `json:"infoHash"`
	InfoURL         string  `json:"infoUrl"`
}

type Cat struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// Search Prowlarr for a free-text query. Pass `categories` to restrict
// (e.g. []{2000} for movies, []{5000} for TV) — leave empty for everything.
//
// Prowlarr's categories follow the Torznab spec:
//   2000-2999  Movies     (2010 SD, 2020 HD, 2040 UHD)
//   5000-5999  TV         (5030 SD, 5040 HD, 5045 UHD)
//   6000-6999  XXX        (don't pass this one)
func (c *Client) Search(ctx context.Context, query string, categories []int) ([]SearchResult, error) {
	q := url.Values{}
	q.Set("query", query)
	q.Set("type", "search")
	for _, cat := range categories {
		q.Add("categories", fmt.Sprintf("%d", cat))
	}
	var arr []SearchResult
	if err := c.do(ctx, http.MethodGet, "/api/v1/search", q, &arr); err != nil {
		return nil, err
	}
	return arr, nil
}

// Helpers for common Notflix searches.
//
// MovieCategories — Torznab 2000-series. SearchMovie restricts to those
// so we don't get a /TV/Anime/XXX mishmash in the results.
var MovieCategories = []int{2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080}

// TVCategories — Torznab 5000-series.
var TVCategories = []int{5000, 5010, 5020, 5030, 5040, 5045, 5050, 5060, 5070, 5080}

func (c *Client) SearchMovie(ctx context.Context, title string, year int) ([]SearchResult, error) {
	q := title
	if year > 0 {
		q = fmt.Sprintf("%s %d", title, year)
	}
	return c.Search(ctx, q, MovieCategories)
}

// SearchTV fires multiple Prowlarr queries with different episode formats
// and merges the results, keyed by GUID/infoHash/title. Indexers vary
// wildly in their naming conventions:
//
//   - Scene / western indexers (TPB, 1337x, RARBG-style): "Show S01E01"
//   - Anime indexers (Nyaa.si, AnimeTosho): "[Group] Show - 01 [1080p]"
//     and "[Group] Show - 001 [BD]" (3-digit padding common)
//
// Firing one combined query for both formats would just return the
// scene format with the anime indexers ignoring it. Firing both as
// separate queries gets us full coverage, at the cost of an extra
// round-trip per episode click (cheap — Prowlarr caches and the
// handler caches the merged set for an hour).
func (c *Client) SearchTV(ctx context.Context, title string, season, episode int) ([]SearchResult, error) {
	queries := buildTVQueries(title, season, episode)

	seen := map[string]bool{}
	var merged []SearchResult
	for _, q := range queries {
		res, err := c.Search(ctx, q, TVCategories)
		if err != nil {
			return nil, err
		}
		for _, r := range res {
			key := dedupeKey(r)
			if seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, r)
		}
	}
	return merged, nil
}

func buildTVQueries(title string, season, episode int) []string {
	if episode > 0 {
		// Always include the SxxExx variant (scene + most western
		// indexers). Add the anime variant — just "Title NN" — so
		// Nyaa-style indexers return matching releases too.
		return []string{
			fmt.Sprintf("%s S%02dE%02d", title, season, episode),
			fmt.Sprintf("%s %02d", title, episode),
		}
	}
	if season > 0 {
		// Season pack — both formats look the same; just one query.
		return []string{fmt.Sprintf("%s S%02d", title, season)}
	}
	return []string{title}
}

// dedupeKey picks the strongest identifier we have for de-duping. GUID
// is Prowlarr's own ID (per-indexer-per-release), infoHash is the
// torrent's content hash (same across indexers), and falling back to
// the title is a safe last resort.
func dedupeKey(r SearchResult) string {
	if r.GUID != "" {
		return "g:" + r.GUID
	}
	if r.InfoHash != "" {
		return "h:" + strings.ToLower(r.InfoHash)
	}
	return "t:" + r.Title
}
