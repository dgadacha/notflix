package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"notflix/internal/prowlarr"

	"github.com/labstack/echo/v4"
)

// In-memory cache for Prowlarr search results.
//
// Prowlarr search fans out to multiple indexers + waits for the slowest
// (1-3s typically). Caching repeats means clicking back on a film you
// already opened today returns sources instantly.
//
// Keyed by (kind, title, year[, season, episode]). TTL is 1h — long
// enough to absorb the same browsing session, short enough to pick up
// new releases when the user comes back tomorrow.
const prowlarrCacheTTL = 1 * time.Hour

type prowlarrCacheEntry struct {
	results   []prowlarr.SearchResult
	expiresAt time.Time
}

var (
	prowlarrCache     = map[string]*prowlarrCacheEntry{}
	prowlarrCacheLock sync.Mutex
)

func prowlarrCacheGet(key string) ([]prowlarr.SearchResult, bool) {
	prowlarrCacheLock.Lock()
	defer prowlarrCacheLock.Unlock()
	e, ok := prowlarrCache[key]
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.results, true
}

func prowlarrCachePut(key string, results []prowlarr.SearchResult) {
	prowlarrCacheLock.Lock()
	defer prowlarrCacheLock.Unlock()
	prowlarrCache[key] = &prowlarrCacheEntry{
		results:   results,
		expiresAt: time.Now().Add(prowlarrCacheTTL),
	}
}

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
// badges without a second call). Raw Prowlarr response is cached for 1h
// per (title, year); TorBox cache state is re-annotated on every call
// so freshly-cached torrents show up correctly.
func (h *Handler) HandleSearchMovie(c echo.Context) error {
	title := c.QueryParam("title")
	if title == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "title required"})
	}
	year, _ := strconv.Atoi(c.QueryParam("year"))

	cacheKey := fmt.Sprintf("movie|%s|%d", strings.ToLower(title), year)
	results, ok := prowlarrCacheGet(cacheKey)
	if !ok {
		fresh, err := h.App.Prowlarr.SearchMovie(c.Request().Context(), title, year)
		if err != nil {
			return RespondErr(c, err)
		}
		results = filterByTitleRelevance(fresh, title)
		prowlarrCachePut(cacheKey, results)
	}
	return RespondOK(c, h.annotateAndSort(c, results))
}

// HandleSearchTV — GET /api/v1/prowlarr/search/tv?title=…&season=…&episode=…
//
// Cached separately per (title, season, episode) so flipping between
// episodes in the same series doesn't refetch the whole show.
func (h *Handler) HandleSearchTV(c echo.Context) error {
	title := c.QueryParam("title")
	if title == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "title required"})
	}
	season, _ := strconv.Atoi(c.QueryParam("season"))
	episode, _ := strconv.Atoi(c.QueryParam("episode"))

	cacheKey := fmt.Sprintf("tv|%s|%d|%d", strings.ToLower(title), season, episode)
	results, ok := prowlarrCacheGet(cacheKey)
	if !ok {
		fresh, err := h.App.Prowlarr.SearchTV(c.Request().Context(), title, season, episode)
		if err != nil {
			return RespondErr(c, err)
		}
		results = filterByTitleRelevance(fresh, title)
		prowlarrCachePut(cacheKey, results)
	}
	return RespondOK(c, h.annotateAndSort(c, results))
}

// filterByTitleRelevance drops Prowlarr results whose title doesn't match
// the searched title closely enough. Prowlarr's Torznab search is fuzzy
// and indexer-dependent; without this filter we've seen "Le Réveil de la
// Momie" leak into Super Mario results (same year, cached on TorBox),
// and "Haibaras Teenage New Game ... The Gray Boys Plan ..." leak into
// "The Boys" results (because the single significant word "boys" matched).
//
// Two strategies depending on how distinctive the title is:
//
//  - SHORT title (≤ 2 significant words after stripping stopwords like
//    "the"/"le"/"of"): we require the full NORMALISED phrase (stopwords
//    kept) to appear as a contiguous substring of the release title.
//    "The Boys" → needle "the boys" — only matches releases that contain
//    "the boys" literally, not "the gray boys" or "beach boys".
//
//  - LONG title (3+ significant words): 60% of those significant words
//    must appear anywhere in the release title. This is robust to
//    word-order variation ("Movie" vs "le film") and missing tokens.
//
// Empty needles → pass-through (don't filter on a title we can't reason
// about).
func filterByTitleRelevance(results []prowlarr.SearchResult, searched string) []prowlarr.SearchResult {
	phrase := strings.TrimSpace(collapseSpaces(normalizeTitle(searched)))
	if phrase == "" {
		return results
	}
	needles := significantWords(phrase)
	if len(needles) == 0 {
		return results
	}

	out := make([]prowlarr.SearchResult, 0, len(results))

	if len(needles) <= 2 {
		// Short title — phrase match required.
		for _, r := range results {
			hay := collapseSpaces(normalizeTitle(r.Title))
			if strings.Contains(hay, phrase) {
				out = append(out, r)
			}
		}
		return out
	}

	// Long title — word-coverage match.
	const threshold = 0.6
	for _, r := range results {
		hay := normalizeTitle(r.Title)
		matched := 0
		for _, w := range needles {
			if strings.Contains(hay, w) {
				matched++
			}
		}
		ratio := float64(matched) / float64(len(needles))
		if ratio >= threshold {
			out = append(out, r)
		}
	}
	return out
}

// collapseSpaces turns runs of whitespace into single spaces. Needed so
// the SHORT-title phrase match isn't tripped up by double spaces left
// behind when normalizeTitle replaces punctuation with spaces.
func collapseSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if r == ' ' {
			if !prevSpace {
				b.WriteByte(' ')
			}
			prevSpace = true
		} else {
			b.WriteRune(r)
			prevSpace = false
		}
	}
	return b.String()
}

// normalizeTitle lowercases, strips accents and collapses every
// non-alphanumeric character to a space — so "Le Réveil de la Momie" and
// "Le.Reveil.De.La.Momie" both become "le reveil de la momie".
func normalizeTitle(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case 'à', 'á', 'â', 'ä', 'ã', 'å', 'ą':
			b.WriteByte('a')
		case 'è', 'é', 'ê', 'ë', 'ę':
			b.WriteByte('e')
		case 'ì', 'í', 'î', 'ï':
			b.WriteByte('i')
		case 'ò', 'ó', 'ô', 'ö', 'õ':
			b.WriteByte('o')
		case 'ù', 'ú', 'û', 'ü':
			b.WriteByte('u')
		case 'ç':
			b.WriteByte('c')
		case 'ñ':
			b.WriteByte('n')
		default:
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				b.WriteRune(r)
			} else {
				b.WriteByte(' ')
			}
		}
	}
	return b.String()
}

// stopwords for title-match — short connective words present in too many
// release names to be useful as needles ("the", "of", "and", French "le"
// "la" "les", …).
var titleStopwords = map[string]bool{
	"the": true, "a": true, "an": true, "of": true, "and": true,
	"to": true, "in": true, "on": true, "for": true, "with": true,
	"le": true, "la": true, "les": true, "un": true, "une": true,
	"des": true, "de": true, "du": true, "et": true, "au": true,
	"aux": true, "ou": true, "il": true, "elle": true,
}

func significantWords(normalized string) []string {
	out := make([]string, 0, 8)
	for _, w := range strings.Fields(normalized) {
		if len(w) < 2 {
			continue
		}
		if titleStopwords[w] {
			continue
		}
		out = append(out, w)
	}
	return out
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
		s += 40 // bonus for French audio (this is Notflix's audience)
	}
	if strings.Contains(t, "cam") || strings.Contains(t, "ts ") || strings.Contains(t, "telesync") {
		s -= 100
	}

	// Audio codec compatibility — Chrome (the dominant Notflix client) can
	// only decode AAC / MP3 / Opus / Vorbis natively. Files muxed with
	// DDP / E-AC-3 / DTS / TrueHD play the video fine but render as muted
	// (volume control greyed out), which feels broken. Nudge the scoring
	// to prefer browser-friendly codecs *among comparably-ranked releases*
	// — the cached-flag bonus (×10000) still dominates so we don't trade
	// a 1080p cached release for an uncached AAC one.
	if strings.Contains(t, "aac") {
		s += 50 // universally decodable in the browser
	}
	if strings.Contains(t, "ddp") || strings.Contains(t, "dd+") ||
		strings.Contains(t, "eac3") || strings.Contains(t, "e-ac3") || strings.Contains(t, "e-ac-3") {
		s -= 100 // Dolby Digital Plus — Chrome can't decode, silent playback
	}
	if strings.Contains(t, "dts") {
		s -= 100 // DTS — same story
	}
	if strings.Contains(t, "truehd") || strings.Contains(t, "atmos") {
		s -= 120 // Dolby TrueHD / Atmos — even Safari struggles, definitely not Chrome
	}
	return s
}
