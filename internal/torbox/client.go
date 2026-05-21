// Package torbox is a thin client for the TorBox debrid API.
//
// Adapted from upstream Seanime (internal/debrid/torbox/torbox.go) but
// stripped down: no debrid abstraction, no realdebrid/alldebrid sibling
// providers, no Result generics. ~250 LOC, plays well with Notflix's
// clean greenfield backend.
//
// Public surface (in order of use):
//
//	c := torbox.NewClient(apiKey)
//	c.Ping(ctx)                             // verify the key
//	cached, _ := c.CheckCached(ctx, hashes) // which magnets are instant?
//	id, _    := c.AddMagnet(ctx, magnet)    // create torrent (instant if cached)
//	info, _  := c.GetTorrent(ctx, id)       // wait for "downloaded" status
//	url, _   := c.RequestDownloadURL(ctx, id, fileID)
package torbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const baseURL = "https://api.torbox.app/v1/api"

type Client struct {
	http *http.Client

	mu     sync.RWMutex
	apiKey string
}

func NewClient(apiKey string) *Client {
	return &Client{
		apiKey: apiKey,
		http:   &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) HasKey() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.apiKey != ""
}

// SetAPIKey swaps the bearer token at runtime. Subsequent requests use
// the new key; no in-flight request is canceled (they'll complete with
// the value they captured at do() entry).
func (c *Client) SetAPIKey(apiKey string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.apiKey = apiKey
}

func (c *Client) currentKey() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.apiKey
}

// -----------------------------------------------------------------------------
// Response envelope — TorBox wraps every response in {"success":bool,"data":...}
// -----------------------------------------------------------------------------

type envelope struct {
	Success bool            `json:"success"`
	Detail  string          `json:"detail"`
	Error   any             `json:"error"`
	Data    json.RawMessage `json:"data"`
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, contentType string) (json.RawMessage, error) {
	apiKey := c.currentKey()
	if apiKey == "" {
		return nil, errors.New("torbox: API key not configured")
	}
	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("torbox %d: %s", res.StatusCode, string(raw))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("torbox: invalid envelope: %w (body: %s)", err, string(raw))
	}
	if !env.Success {
		return nil, fmt.Errorf("torbox error: %v (%s)", env.Error, env.Detail)
	}
	return env.Data, nil
}

// -----------------------------------------------------------------------------
// /api/user/me — health + auth check
// -----------------------------------------------------------------------------

type User struct {
	ID                int    `json:"id"`
	Email             string `json:"email"`
	Plan              int    `json:"plan"`
	IsSubscribed      bool   `json:"is_subscribed"`
	PremiumExpiresAt  string `json:"premium_expires_at"`
}

func (c *Client) Ping(ctx context.Context) (*User, error) {
	data, err := c.do(ctx, http.MethodGet, "/user/me", nil, "")
	if err != nil {
		return nil, err
	}
	var u User
	if err := json.Unmarshal(data, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// -----------------------------------------------------------------------------
// /api/torrents/checkcached — bulk lookup ; which infohashes are
// instantly streamable from TorBox's cache?
// -----------------------------------------------------------------------------

type CachedFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Hash string `json:"hash"`
}

// CheckCached returns the cached state for each hash. The map is keyed by
// the original (lower-cased) hash. Missing keys = not cached.
func (c *Client) CheckCached(ctx context.Context, hashes []string) (map[string]bool, error) {
	if len(hashes) == 0 {
		return map[string]bool{}, nil
	}
	// API limit: ~100 hashes per call. Batch to be safe.
	const batchSize = 100
	out := make(map[string]bool, len(hashes))
	for i := 0; i < len(hashes); i += batchSize {
		end := i + batchSize
		if end > len(hashes) {
			end = len(hashes)
		}
		batch := hashes[i:end]
		q := strings.Join(lowerAll(batch), ",")
		data, err := c.do(ctx, http.MethodGet, "/torrents/checkcached?hash="+q+"&format=list&list_files=true", nil, "")
		if err != nil {
			return nil, err
		}
		// `format=list` returns either an array of objects (cached) or
		// an empty array. Build the boolean map by membership.
		var arr []struct {
			Hash string `json:"hash"`
		}
		if err := json.Unmarshal(data, &arr); err != nil {
			// Some responses come back as a {} object — treat as empty.
			continue
		}
		for _, e := range arr {
			out[strings.ToLower(e.Hash)] = true
		}
	}
	return out, nil
}

// -----------------------------------------------------------------------------
// /api/torrents/createtorrent — add a magnet to the account
// -----------------------------------------------------------------------------

type CreateResult struct {
	TorrentID int    `json:"torrent_id"`
	AuthID    string `json:"auth_id"`
	Hash      string `json:"hash"`
	Queued    bool   `json:"queued_id"`
}

// AddMagnet posts a magnet link via multipart. Returns the assigned torrent
// id. If the magnet is already cached, TorBox returns immediately and a
// subsequent GetTorrent call shows download_state="cached" / state "ready".
func (c *Client) AddMagnet(ctx context.Context, magnet string) (*CreateResult, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("magnet", magnet)
	_ = w.WriteField("seed", "3") // auto: seed if needed
	_ = w.WriteField("allow_zip", "true")
	w.Close()

	data, err := c.do(ctx, http.MethodPost, "/torrents/createtorrent", &body, w.FormDataContentType())
	if err != nil {
		return nil, err
	}
	var res CreateResult
	if err := json.Unmarshal(data, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// AddTorrentFile uploads a .torrent file via the same /torrents/createtorrent
// endpoint, using the multipart `file` field instead of `magnet`. Used when
// Prowlarr returns indexer URLs that don't expose a magnet directly — we
// fetch the .torrent server-side then forward the bytes here.
func (c *Client) AddTorrentFile(ctx context.Context, filename string, content []byte) (*CreateResult, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		return nil, err
	}
	if _, err := fw.Write(content); err != nil {
		return nil, err
	}
	_ = w.WriteField("seed", "3")
	_ = w.WriteField("allow_zip", "true")
	w.Close()

	data, err := c.do(ctx, http.MethodPost, "/torrents/createtorrent", &body, w.FormDataContentType())
	if err != nil {
		return nil, err
	}
	var res CreateResult
	if err := json.Unmarshal(data, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// -----------------------------------------------------------------------------
// /api/torrents/mylist — poll for state / list files
// -----------------------------------------------------------------------------

type Torrent struct {
	ID               int           `json:"id"`
	Hash             string        `json:"hash"`
	Name             string        `json:"name"`
	Size             int64         `json:"size"`
	Active           bool          `json:"active"`
	DownloadState    string        `json:"download_state"`
	DownloadFinished bool          `json:"download_finished"`
	DownloadPresent  bool          `json:"download_present"`
	Progress         float64       `json:"progress"`
	Cached           bool          `json:"cached"`
	Files            []TorrentFile `json:"files"`
}

type TorrentFile struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	ShortName string `json:"short_name"`
	Size      int64  `json:"size"`
	S3Path    string `json:"s3_path"`
}

func (c *Client) GetTorrent(ctx context.Context, id int) (*Torrent, error) {
	data, err := c.do(ctx, http.MethodGet, "/torrents/mylist?bypass_cache=true&id="+strconv.Itoa(id), nil, "")
	if err != nil {
		return nil, err
	}
	var t Torrent
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

func (c *Client) ListTorrents(ctx context.Context) ([]Torrent, error) {
	data, err := c.do(ctx, http.MethodGet, "/torrents/mylist?bypass_cache=true", nil, "")
	if err != nil {
		return nil, err
	}
	var arr []Torrent
	if err := json.Unmarshal(data, &arr); err != nil {
		return nil, err
	}
	return arr, nil
}

// -----------------------------------------------------------------------------
// /api/torrents/requestdl — get the time-limited stream URL
// -----------------------------------------------------------------------------

// RequestDownloadURL returns a direct streamable URL for a specific file in
// a torrent. Pass fileID >= 0 for a single-file URL. Pass -1 to get a zip
// of the whole torrent (rarely useful — the browser can't play a zip, so
// /watch should always pick a real file).
//
// Sentinel was changed from `0` to `-1` because TorBox file IDs start at
// 0 in some torrents — confusing "no file picked" with "the first file"
// is exactly how the player ended up loading store-XXX/zip/... and
// failing.
func (c *Client) RequestDownloadURL(ctx context.Context, torrentID, fileID int) (string, error) {
	q := url.Values{}
	q.Set("token", c.currentKey())
	q.Set("torrent_id", strconv.Itoa(torrentID))
	if fileID >= 0 {
		q.Set("file_id", strconv.Itoa(fileID))
	} else {
		q.Set("zip_link", "true")
	}
	data, err := c.do(ctx, http.MethodGet, "/torrents/requestdl?"+q.Encode(), nil, "")
	if err != nil {
		return "", err
	}
	// `data` is a JSON-encoded string when successful.
	var streamURL string
	if err := json.Unmarshal(data, &streamURL); err != nil {
		return "", fmt.Errorf("torbox: unexpected requestdl payload: %w", err)
	}
	return streamURL, nil
}

// -----------------------------------------------------------------------------
// /api/torrents/controltorrent — delete a torrent
// -----------------------------------------------------------------------------

func (c *Client) DeleteTorrent(ctx context.Context, id int) error {
	payload, _ := json.Marshal(map[string]any{
		"torrent_id": id,
		"operation":  "delete",
	})
	_, err := c.do(ctx, http.MethodPost, "/torrents/controltorrent", bytes.NewReader(payload), "application/json")
	return err
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

func lowerAll(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = strings.ToLower(s)
	}
	return out
}
