package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// HandleYouTubeCheck — GET /api/v1/youtube/check?id=<videoId>
//
// Reports whether a YouTube video can be embedded. Used by the
// detail-modal trailer button to fail-fast on geoblocked, removed,
// age-restricted or otherwise unavailable videos before sticking
// the user inside a YouTube error iframe.
//
// Mechanism: hit YouTube's oEmbed endpoint. It returns:
//   - 200 OK + metadata (title / author) when embeddable
//   - 401 / 403 when restricted (geoblock, age, embed disabled)
//   - 404 when the video doesn't exist
//
// Result is memoised for 1 h — videos rarely flip availability and
// the oEmbed endpoint is rate-limited per IP.
func (h *Handler) HandleYouTubeCheck(c echo.Context) error {
	videoID := strings.TrimSpace(c.QueryParam("id"))
	if videoID == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "id required"})
	}
	// Crude sanitisation — YouTube IDs are [A-Za-z0-9_-]{11}.
	if !isYouTubeID(videoID) {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid id"})
	}

	if cached, ok := youtubeCacheGet(videoID); ok {
		return RespondOK(c, cached)
	}

	result := probeYouTubeEmbed(c.Request().Context(), videoID)
	youtubeCachePut(videoID, result)
	return RespondOK(c, result)
}

type youtubeCheckResult struct {
	Available bool   `json:"available"`
	Title     string `json:"title,omitempty"`
	Author    string `json:"author,omitempty"`
	Reason    string `json:"reason,omitempty"` // human-readable for the UI
}

func probeYouTubeEmbed(ctx echoContext, videoID string) youtubeCheckResult {
	u := "https://www.youtube.com/oembed?format=json&url=" +
		url.QueryEscape("https://www.youtube.com/watch?v="+videoID)

	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return youtubeCheckResult{Available: false, Reason: "request_build_failed"}
	}
	req.Header.Set("User-Agent", "Notflix/1.0")

	res, err := client.Do(req)
	if err != nil {
		return youtubeCheckResult{Available: false, Reason: "fetch_failed"}
	}
	defer res.Body.Close()

	switch res.StatusCode {
	case http.StatusOK:
		var body struct {
			Title  string `json:"title"`
			Author string `json:"author_name"`
		}
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		_ = json.Unmarshal(raw, &body)
		return youtubeCheckResult{Available: true, Title: body.Title, Author: body.Author}
	case http.StatusUnauthorized, http.StatusForbidden:
		// 401/403 = embed disabled / geoblocked / age-gated.
		return youtubeCheckResult{Available: false, Reason: "restricted"}
	case http.StatusNotFound:
		return youtubeCheckResult{Available: false, Reason: "not_found"}
	default:
		return youtubeCheckResult{
			Available: false,
			Reason:    fmt.Sprintf("oembed_%d", res.StatusCode),
		}
	}
}

func isYouTubeID(s string) bool {
	if len(s) != 11 {
		return false
	}
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			r == '_' || r == '-'
		if !ok {
			return false
		}
	}
	return true
}

// In-memory cache, no eviction beyond the TTL check on read. Cache
// entries are tiny (<200 B) and YouTube video IDs are bounded — the
// cardinality stays in the low thousands at worst.
var (
	youtubeCacheMu sync.RWMutex
	youtubeCache   = map[string]youtubeCacheEntry{}
)

type youtubeCacheEntry struct {
	result    youtubeCheckResult
	expiresAt time.Time
}

const youtubeCacheTTL = 1 * time.Hour

func youtubeCacheGet(id string) (youtubeCheckResult, bool) {
	youtubeCacheMu.RLock()
	defer youtubeCacheMu.RUnlock()
	e, ok := youtubeCache[id]
	if !ok || time.Now().After(e.expiresAt) {
		return youtubeCheckResult{}, false
	}
	return e.result, true
}

func youtubeCachePut(id string, r youtubeCheckResult) {
	youtubeCacheMu.Lock()
	defer youtubeCacheMu.Unlock()
	youtubeCache[id] = youtubeCacheEntry{
		result:    r,
		expiresAt: time.Now().Add(youtubeCacheTTL),
	}
}

// echoContext mirrors the http.Request context the handler hands us.
// Defined as a tiny alias so probeYouTubeEmbed signature stays clean.
type echoContext = interface {
	// We only use Deadline + Done + Value indirectly via the stdlib
	// http.Client (which accepts a context.Context). Echo's
	// c.Request().Context() satisfies this.
	Deadline() (time.Time, bool)
	Done() <-chan struct{}
	Err() error
	Value(key any) any
}

// (placate any "unused" linter complaints if a future refactor drops
// the import — Echo's context fulfills echoContext by structural
// typing, no explicit import needed.)
var _ = echo.New
