package handlers

import (
	"fmt"
	"net/http"
	"regexp"
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

// HandleProwlarrHealth — GET /api/v1/prowlarr/health
//
// Detailed health report: system status + per-indexer stats. Used by
// the settings UI to render the green/yellow/red dots next to each
// indexer.
//
// One IndexerHealth row per indexer:
//   - up:        Enable && (no recent failures OR successful queries)
//   - degraded:  some queries failed in the rolling window
//   - down:      all recent queries failed OR indexer disabled
//
// Indexers that have never been queried (numberOfQueries == 0) show
// up as "unknown" so the UI can render them as a neutral dot rather
// than red.
func (h *Handler) HandleProwlarrHealth(c echo.Context) error {
	if !h.App.Prowlarr.Configured() {
		return RespondOK(c, map[string]any{"configured": false})
	}
	ctx := c.Request().Context()
	sys, err := h.App.Prowlarr.SystemStatus(ctx)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{
			"configured": true,
			"up":         false,
			"error":      err.Error(),
		})
	}
	indexers, idxErr := h.App.Prowlarr.ListIndexers(ctx)
	if idxErr != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{
			"configured": true,
			"up":         true,
			"version":    sys.Version,
			"error":      "indexer list: " + idxErr.Error(),
		})
	}
	stats, _ := h.App.Prowlarr.IndexerStats(ctx) // best-effort

	statByID := make(map[int]prowlarr.IndexerStat, len(stats))
	for _, s := range stats {
		statByID[s.IndexerID] = s
	}

	type indexerHealth struct {
		ID                  int    `json:"id"`
		Name                string `json:"name"`
		Enable              bool   `json:"enable"`
		Protocol            string `json:"protocol"`
		Status              string `json:"status"` // "up" | "degraded" | "down" | "unknown" | "disabled"
		Queries             int    `json:"queries"`
		Failures            int    `json:"failures"`
		AverageResponseTime int    `json:"averageResponseTimeMs"`
	}

	out := make([]indexerHealth, 0, len(indexers))
	for _, ix := range indexers {
		st := statByID[ix.ID]
		h := indexerHealth{
			ID:                  ix.ID,
			Name:                ix.Name,
			Enable:              ix.Enable,
			Protocol:            ix.Protocol,
			Queries:             st.NumberOfQueries,
			Failures:            st.NumberOfFailedQueries,
			AverageResponseTime: st.AverageResponseTime,
		}
		switch {
		case !ix.Enable:
			h.Status = "disabled"
		case st.NumberOfQueries == 0:
			h.Status = "unknown"
		case st.NumberOfFailedQueries == 0:
			h.Status = "up"
		case st.NumberOfFailedQueries < st.NumberOfQueries:
			h.Status = "degraded"
		default:
			h.Status = "down"
		}
		out = append(out, h)
	}

	enabled := 0
	for _, ix := range indexers {
		if ix.Enable {
			enabled++
		}
	}

	return RespondOK(c, map[string]any{
		"configured":      true,
		"up":              true,
		"appName":         sys.AppName,
		"version":         sys.Version,
		"indexerCount":    len(indexers),
		"enabledIndexers": enabled,
		"indexers":        out,
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
		results = filterByTitleRelevance(fresh, title, mediaMovie)
		results = filterByContentType(results, title, mediaMovie)
		if year > 0 {
			results = filterByReleaseYear(results, year, 2)
		}
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
		results = filterByTitleRelevance(fresh, title, mediaTV)
		results = filterByContentType(results, title, mediaTV)
		if episode > 0 {
			results = filterByEpisodeMatch(results, season, episode)
		}
		prowlarrCachePut(cacheKey, results)
	}
	return RespondOK(c, h.annotateAndSort(c, results))
}

// mediaCtx is the search context — controls a couple of tokenisation
// decisions that differ between movies and TV. The big one is whether
// 1-2 digit standalone numbers count as title characters (they can —
// "Apollo 13", "Die Hard 2") or as episode markers ("Naruto - 01").
type mediaCtx int

const (
	mediaMovie mediaCtx = iota
	mediaTV
)

// filterByTitleRelevance drops Prowlarr results whose series title doesn't
// match the searched title exactly. Prowlarr's Torznab search is fuzzy
// and indexer-dependent — without this filter we've seen
//
//   - "Le Réveil de la Momie" leak into Super Mario Galaxy results
//     (because both happen to be cached on TorBox in the same year),
//   - "Haibara's Teenage New Game ... The Gray Boys Plan ..." leak into
//     "The Boys" (the single needle "boys" was enough to match),
//   - "Boruto - Naruto Next Generations" leak into Naruto (Naruto is
//     a literal substring of the longer compound name),
//   - "Spider-Man: Across the Spider-Verse" leak into Spider-Man (same
//     pattern — the sequel's full name starts with the original).
//
// The fix is to compare the SERIES PORTION of each release — the prefix
// before the first format marker (SxxExx, 1080p, 2023, bluray, …) — to
// the searched title, both reduced to their significant tokens (no
// stopwords, no format markers). Same number of tokens, in the same
// order, or the release is rejected. This is strict on purpose:
//
//   "Naruto"                     → ["naruto"]
//   "Boruto - Naruto Next Gens"  → ["boruto", "naruto", "next", "gens"]
//      → 1 ≠ 4 → REJECTED
//
//   "Spider-Man"                 → ["spider", "man"]
//   "Spider-Man Across the SV"   → ["spider", "man", "across", "sv"]
//      → 2 ≠ 4 → REJECTED
//
//   "Naruto Shippuden"           → ["naruto", "shippuden"]
//   "Naruto S01E01" series       → ["naruto"]
//      → 2 ≠ 1 → REJECTED (Shippuden release stays out of plain Naruto)
//
// Empty needles → pass-through (don't filter on a title we can't reason
// about, e.g. the user typed a single stopword).
func filterByTitleRelevance(results []prowlarr.SearchResult, searched string, ctx mediaCtx) []prowlarr.SearchResult {
	needles := extractSeriesTokens(searched, ctx)
	if len(needles) == 0 {
		return results
	}
	out := make([]prowlarr.SearchResult, 0, len(results))
	for _, r := range results {
		releaseToks := extractSeriesTokens(stripLeadingBrackets(r.Title), ctx)
		if matchesTitlePrefix(releaseToks, needles) {
			out = append(out, r)
		}
	}
	return out
}

// matchesTitlePrefix returns true iff the series tokens of `releaseToks`
// equal `needles` exactly — same length, same content, same order. The
// series portion has already been trimmed at the first format marker,
// so anything that pads extra words onto the front ("Boruto Naruto …")
// or the back ("Naruto Shippuden") is rejected.
func matchesTitlePrefix(releaseToks, needles []string) bool {
	if len(releaseToks) != len(needles) {
		return false
	}
	for i, w := range needles {
		if releaseToks[i] != w {
			return false
		}
	}
	return true
}

// extractSeriesTokens returns the LEADING significant tokens of a title,
// stopping at the first format marker. Tokens past the first marker are
// release metadata — quality tags, codec, group name suffix, etc — and
// would otherwise pollute the comparison (e.g. "Naruto.S01E01-FGT"
// would tokenise to ["naruto", "fgt"] without the truncation).
//
// Stopwords are silently skipped (they don't end the series portion,
// just don't count as content tokens).
func extractSeriesTokens(s string, ctx mediaCtx) []string {
	normed := normalizeTitle(s)
	out := make([]string, 0, 8)
	for _, w := range strings.Fields(normed) {
		if titleStopwords[w] {
			continue
		}
		if isFormatMarkerToken(w, ctx) {
			// First marker hit — everything past this point is metadata.
			break
		}
		out = append(out, w)
	}
	return out
}

// stripLeadingBrackets removes leading [Group] / (Year) / {Tag} markers
// from a release title before tokenisation, so the actual series name
// surfaces as the first significant token. Anime releases are the
// usual culprit ("[HorribleSubs] Naruto - 001 [1080p].mkv") but western
// scene releases use it too.
var leadingBracketsPattern = regexp.MustCompile(`^(\s*[\[({][^\])}]*[\])}]\s*)+`)

func stripLeadingBrackets(s string) string {
	return leadingBracketsPattern.ReplaceAllString(s, "")
}

// isFormatMarkerToken reports whether a normalised token is a release
// metadata fragment (quality, codec, language, season/episode marker,
// year, source) rather than a part of the title. Used to find where
// the series portion ends.
//
// Behaviour depends on the search context: for TV searches we ALSO
// strip 1-2 digit standalone numbers (anime episodes like "Naruto - 01"
// or short-padded "Naruto - 7"). For movie searches those stay in the
// title because they can legitimately be part of it ("Apollo 13",
// "Die Hard 2", "Toy Story 3").
func isFormatMarkerToken(t string, ctx mediaCtx) bool {
	if formatMarkerTokens[t] {
		return true
	}
	if sxxExxPattern.MatchString(t) || exxPattern.MatchString(t) {
		return true
	}
	if !allDigits(t) {
		return false
	}
	switch len(t) {
	case 3, 4:
		// Year or anime absolute episode (e.g. "001", "2023").
		return true
	case 1, 2:
		// For TV, almost always an episode number ("01" in "Naruto 01").
		// For movies, conservative — keep as a title token.
		return ctx == mediaTV
	}
	return false
}

var (
	sxxExxPattern = regexp.MustCompile(`^s\d{1,3}(e\d{1,4})?$`)
	exxPattern    = regexp.MustCompile(`^e\d{1,4}$`)
)

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// formatMarkerTokens — known scene / fansub release tags. The list is
// not exhaustive but covers everything we've seen in the wild that
// would otherwise pollute the series-portion extraction.
var formatMarkerTokens = map[string]bool{
	// Resolution
	"360p": true, "480p": true, "720p": true, "1080p": true, "1440p": true,
	"2160p": true, "4320p": true, "4k": true, "uhd": true, "hd": true,
	"fhd": true, "qhd": true, "sd": true,
	// Source
	"bluray": true, "bdrip": true, "brrip": true, "bdremux": true,
	"dvdrip": true, "dvdscr": true, "dvd": true,
	"webdl": true, "webrip": true, "web": true,
	"hdtv": true, "hdrip": true, "pdtv": true, "sdtv": true,
	"remux": true, "screener": true, "cam": true, "ts": true,
	"telesync": true, "telecine": true, "tc": true, "r5": true,
	// Codec
	"x264": true, "x265": true, "h264": true, "h265": true, "hevc": true,
	"avc": true, "xvid": true, "divx": true, "vp9": true, "av1": true,
	// Audio
	"aac": true, "ac3": true, "dts": true, "ddp": true, "eac3": true,
	"truehd": true, "atmos": true, "flac": true, "opus": true,
	"mp3": true, "dd": true, "dd5": true, "dd7": true,
	// Language
	"multi": true, "french": true, "vff": true, "vfq": true, "vostfr": true,
	"truefrench": true, "subbed": true, "dubbed": true, "vo": true,
	"vost": true, "subfrench": true, "english": true, "japanese": true,
	"fastsub": true, "engsub": true, "raw": true,
	// Labels
	"season": true, "episode": true, "ep": true, "pack": true,
	"complete": true, "proper": true, "repack": true, "rerip": true,
	"extended": true, "uncut": true, "imax": true, "criterion": true,
	"remastered": true, "anime": true, "ova": true, "ona": true,
	"special": true, "specials": true, "movie": true, "film": true,
	"hdr": true, "hdr10": true, "dv": true, "10bit": true, "8bit": true,
}

// filterByContentType drops releases whose content type doesn't match
// the search type. The title filter alone is too forgiving — it accepts
// any release whose series-portion equals the search, which lets:
//
//   - "Jujutsu Kaisen Movie 01" (the spin-off film) leak into a search
//     for the TV series, because "movie" was treated as a format marker
//     and the series portion ["jujutsu", "kaisen"] matched. The standalone
//     "01" then passed the episode filter as if it were ep 1.
//   - TV episode releases ("Foo S01E01") leak into movie searches,
//     because SxxExx is stripped as a format marker and the series
//     ["foo"] matches the movie name.
//
// The rule: a release must not advertise a content type incompatible
// with the search. For TV: reject "movie" / "film" / "ova" / "ona" /
// "special" tokens UNLESS they appear in the search title itself (rare
// but possible — a show named "The Movie Quiz"). For movies: reject
// any release that carries a season or episode marker (SxxExx, Sxx,
// "season", "episode", "ep").
func filterByContentType(results []prowlarr.SearchResult, searched string, ctx mediaCtx) []prowlarr.SearchResult {
	searchTokens := tokenizeRaw(searched)
	searchHas := func(tok string) bool {
		for _, t := range searchTokens {
			if t == tok {
				return true
			}
		}
		return false
	}

	out := make([]prowlarr.SearchResult, 0, len(results))
	for _, r := range results {
		releaseTokens := tokenizeRaw(stripLeadingBrackets(r.Title))
		if !hasContentTypeMismatch(releaseTokens, ctx, searchHas) {
			out = append(out, r)
		}
	}
	return out
}

// tokenizeRaw splits a string on every non-alphanumeric character and
// lowercases the result. Same convention as releaseAdvertisesEpisode.
func tokenizeRaw(s string) []string {
	s = strings.ToLower(s)
	return strings.FieldsFunc(s, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'))
	})
}

// hasContentTypeMismatch reports whether the release advertises a
// content type at odds with the search (movie-tagged release in a TV
// search, TV-episode-tagged release in a movie search).
//
// `searchHas` is consulted before rejecting on "movie"/"film": if the
// search itself contains that token, the release is welcome to as well.
func hasContentTypeMismatch(tokens []string, ctx mediaCtx, searchHas func(string) bool) bool {
	switch ctx {
	case mediaTV:
		for _, tok := range tokens {
			switch tok {
			case "movie", "film":
				if !searchHas(tok) {
					return true
				}
			case "ova", "ona":
				return true
			}
		}
	case mediaMovie:
		for _, tok := range tokens {
			// S01E01 / S01 / standalone "season" or "episode" → TV signal.
			if sxxExxFullPattern.MatchString(tok) {
				return true
			}
			if seasonOnlyPattern.MatchString(tok) {
				return true
			}
			switch tok {
			case "season", "episode", "ep":
				if !searchHas(tok) {
					return true
				}
			}
		}
	}
	return false
}

// filterByEpisodeMatch drops TV releases that don't advertise the right
// episode in their title. Needed because we now fire two Prowlarr
// queries (SxxExx + bare "Title NN"), and the bare-NN variant can pull
// in releases for other episodes (e.g. "Naruto 220" when we want ep 1).
//
// Tokenises each release title and inspects every token, tracking
// whether we saw:
//   - the exact SxxExx for our episode (best signal)
//   - any SxxExx — if wrong-season-or-episode, the release is rejected
//   - the right season alone (S0x with no Ex) — accepted as a season pack
//   - any season alone (wrong number) — rejected
//   - a standalone episode marker (E01, EP01, 01, 001) — accepted
//
// Tokenisation strips non-alphanumeric noise (dots, dashes, brackets)
// so "Naruto.S01E01", "Naruto S01 E01" and "[Group] Naruto - S01E01"
// all become the same token stream.
func filterByEpisodeMatch(results []prowlarr.SearchResult, season, episode int) []prowlarr.SearchResult {
	out := make([]prowlarr.SearchResult, 0, len(results))
	for _, r := range results {
		if releaseAdvertisesEpisode(r.Title, season, episode) {
			out = append(out, r)
		}
	}
	return out
}

var (
	sxxExxFullPattern = regexp.MustCompile(`^s(\d{1,3})e(\d{1,4})$`)
	seasonOnlyPattern = regexp.MustCompile(`^s(\d{1,3})$`)
	episodeOnlyEPat   = regexp.MustCompile(`^e(\d{1,4})$`)
	episodeOnlyEpPat  = regexp.MustCompile(`^ep(\d{1,4})$`)
)

func releaseAdvertisesEpisode(release string, season, episode int) bool {
	cleaned := strings.ToLower(stripLeadingBrackets(release))
	// Tokenise on any non-alphanumeric run — same idea as normalizeTitle
	// but we keep tokens as-is (no accent folding needed for these
	// alphanumeric markers).
	tokens := strings.FieldsFunc(cleaned, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'))
	})

	var (
		hasCorrectSxxExx  bool
		hasWrongSxxExx    bool
		hasCorrectSeason  bool
		hasWrongSeason    bool
		hasStandaloneEpHit bool
	)

	for _, tok := range tokens {
		// SxxExx — the strongest signal: explicit season + episode.
		if m := sxxExxFullPattern.FindStringSubmatch(tok); m != nil {
			s, _ := strconv.Atoi(m[1])
			e, _ := strconv.Atoi(m[2])
			if s == season && e == episode {
				hasCorrectSxxExx = true
			} else {
				hasWrongSxxExx = true
			}
			continue
		}
		// Sxx alone (no episode part). A release tagged "Naruto.S01" is
		// a season pack containing every S01 episode — accept if season
		// matches.
		if m := seasonOnlyPattern.FindStringSubmatch(tok); m != nil {
			s, _ := strconv.Atoi(m[1])
			if s == season {
				hasCorrectSeason = true
			} else {
				hasWrongSeason = true
			}
			continue
		}
		// Exx — explicit episode marker, no season tag (anime + some
		// scene releases).
		if m := episodeOnlyEPat.FindStringSubmatch(tok); m != nil {
			e, _ := strconv.Atoi(m[1])
			if e == episode {
				hasStandaloneEpHit = true
			}
			continue
		}
		// EPxx — same idea, longer prefix.
		if m := episodeOnlyEpPat.FindStringSubmatch(tok); m != nil {
			e, _ := strconv.Atoi(m[1])
			if e == episode {
				hasStandaloneEpHit = true
			}
			continue
		}
		// Pure digit token — anime absolute episode "Naruto 01" / "001".
		// Skip 4-digit numbers (years, never episode IDs in practice).
		if allDigits(tok) && len(tok) <= 3 {
			n, _ := strconv.Atoi(tok)
			if n == episode {
				hasStandaloneEpHit = true
			}
			continue
		}
	}

	// Decision tree — strongest signal first.
	if hasCorrectSxxExx {
		return true
	}
	if hasWrongSxxExx {
		// Has SxxExx but for a different ep/season — definitely not us.
		return false
	}
	if hasCorrectSeason {
		// Season pack containing our episode — keep.
		return true
	}
	if hasWrongSeason {
		// Wrong season pack — skip even if a stray "01" digit matches.
		return false
	}
	return hasStandaloneEpHit
}

// filterByReleaseYear drops releases whose year, as advertised in the
// title, differs from the searched year by more than `tolerance`.
//
// Title-relevance alone isn't enough to tell the difference between
// "Spider-Man 2002" and "Spider-Man: Across the Spider-Verse 2023" —
// both contain the literal "spider man" phrase. Year filtering catches
// the ambiguity: 2002 ± 2 → keeps remasters/re-releases (2002, 2003,
// 2004), drops the 2023 sequel.
//
// Releases without an explicit year in their title are KEPT — we can't
// tell from the filename, so we'd rather have a false positive than
// silently drop a perfectly fine release that just doesn't tag the
// year in the standard way.
func filterByReleaseYear(results []prowlarr.SearchResult, searchedYear, tolerance int) []prowlarr.SearchResult {
	out := make([]prowlarr.SearchResult, 0, len(results))
	for _, r := range results {
		y := extractReleaseYear(r.Title)
		if y == 0 {
			out = append(out, r)
			continue
		}
		diff := searchedYear - y
		if diff < 0 {
			diff = -diff
		}
		if diff <= tolerance {
			out = append(out, r)
		}
	}
	return out
}

// extractReleaseYear pulls the first 4-digit year between 1970 and 2039
// out of a release title. "Spider-Man.2002.1080p.BluRay-RARBG" → 2002.
// Returns 0 when no year-shaped token is found.
var releaseYearPattern = regexp.MustCompile(`\b(19[7-9]\d|20[0-3]\d)\b`)

func extractReleaseYear(title string) int {
	match := releaseYearPattern.FindString(title)
	if match == "" {
		return 0
	}
	n, _ := strconv.Atoi(match)
	return n
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
			// Speed tier — UI badge. "instant" / "fast" / "normal" /
			// "slow" / "very_slow". Cached releases are always instant
			// because TorBox serves them from its CDN; non-cached
			// releases depend on how fast TorBox can peer-fetch from
			// the seeders.
			"speedTier": releaseSpeedTier(isCached, r.Seeders),
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
//  1. Cached on TorBox (= instant playback) — dominant factor (1M bonus)
//  2. For NON-CACHED releases: number of seeders gates everything
//     else. TorBox has to peer-fetch the file in real time; a release
//     with 2 seeders streams at ~500 KB/s no matter how good its
//     1080p HEVC quality is. We add seeder-tier bonuses/penalties so
//     between two non-cached releases the well-seeded one wins
//     decisively, even if the dead one is "higher quality".
//  3. Quality markers in the title (BluRay, 1080p, HEVC, French audio)
//  4. File size sweet spot (1-5 GB for 1080p)
//
// Negative weight on CAMs / telesyncs / oversized remuxes.
func scoreRelease(r prowlarr.SearchResult, cached bool) float64 {
	var score float64
	if cached {
		// Cached on TorBox = instant playback. Everything else
		// (non-cached releases) means the user waits 1-3 min for
		// TorBox to peer-fetch the file. That's so much worse that
		// no quality difference is worth it: a cached SD release
		// beats a non-cached BluRay in our scoring.
		// Bumped 10k → 1M after the user spent 3+ min watching
		// "TorBox télécharge la source" on a Spider-Man release
		// whose cached French alternatives existed but were
		// pushed down by seeder counts.
		score += 1_000_000
	} else {
		// Seeder tiers — only applied to non-cached releases.
		// Thresholds tuned for TorBox's peer-fetch throughput:
		//   - <3 seeders   = essentially dead, ~kbps to ~hundreds kbps
		//   - 3-9 seeders  = slow, ~1-2 MB/s, buffers on a 5 Mbps line
		//   - 10-19        = OK, ~3-5 MB/s
		//   - 20-49        = good, ~5-10 MB/s
		//   - 50+          = full speed, saturates most home ISPs
		switch {
		case r.Seeders < 3:
			// Effectively disqualifies the release unless it's the
			// only one available. Magnitude > qualityScore's max (~75).
			score -= 200
		case r.Seeders < 10:
			score -= 50
		case r.Seeders >= 50:
			score += 30
		case r.Seeders >= 20:
			score += 15
		}
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

// releaseSpeedTier classifies how fast a release will stream from
// TorBox. Used as a UI badge in the source picker so the user knows
// what they're picking. Cached → CDN throughput; non-cached → bound
// by TorBox's peer-fetch from seeders.
//
// Tier strings are stable — the frontend pattern-matches on them.
func releaseSpeedTier(cached bool, seeders int) string {
	if cached {
		return "instant"
	}
	switch {
	case seeders >= 50:
		return "fast"
	case seeders >= 10:
		return "normal"
	case seeders >= 3:
		return "slow"
	default:
		return "very_slow"
	}
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

	// Video codec compatibility — `<video>` natively decodes H.264 + VP8/9 +
	// AV1 (Chrome 90+). XviD / DivX / MPEG-4 ASP releases sit inside AVI
	// containers that the browser can't even MUX, let alone DECODE. We've
	// seen Spider-Man French.BDRip.XviD-EXTREME show up as "Recommandé"
	// because it was cached and well-seeded, then the player just errored
	// out silently. Hard penalty so they never auto-pick when an H.264
	// alternative exists.
	if strings.Contains(t, "xvid") || strings.Contains(t, "divx") {
		s -= 500
	}
	// Plain ".avi" in the title (without xvid/divx tags) usually still
	// means a legacy codec. Slightly softer penalty in case it's actually
	// H.264-in-AVI (rare but valid).
	if strings.Contains(t, ".avi") || strings.HasSuffix(t, " avi") {
		s -= 200
	}
	// MPEG-2 / MPEG-1 — DVD-era video, browser can't decode.
	if strings.Contains(t, "mpeg-2") || strings.Contains(t, "mpeg2") {
		s -= 300
	}
	// Bump for the codecs Chrome decodes natively.
	if strings.Contains(t, "h.264") || strings.Contains(t, "h264") || strings.Contains(t, "x264") || strings.Contains(t, "avc") {
		s += 5
	}

	return s
}
