// Package library scans a local directory for video files, parses their
// filenames into (title, year), looks each one up on TMDB, and persists
// the result as a LocalFile row. The frontend then renders these as a
// "Bibliothèque locale" rail on the home page; clicking a card plays
// the file directly from disk through the stream endpoint, bypassing
// Prowlarr + TorBox entirely.
//
// Scope: movies only. TV is deferred — episode parsing has enough
// edge cases (S01E01 vs " - 01 " vs 1x01) that mixing it into the
// same scanner produces wrong matches half the time. Add a separate
// scanner mode later.
package library

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"notflix/internal/database/db"
	"notflix/internal/database/models"
	"notflix/internal/tmdb"
)

// Extensions we treat as playable video. Other media (subs, nfo,
// readme, sample folders) are skipped silently.
var videoExtensions = map[string]bool{
	".mkv":  true,
	".mp4":  true,
	".m4v":  true,
	".avi":  true,
	".mov":  true,
	".webm": true,
	".wmv":  true,
	".flv":  true,
	".ts":   true,
	".mpg":  true,
	".mpeg": true,
}

// Minimum file size to consider — release groups ship 5-50 KB "Sample"
// teaser files inside the same folder. Anything under 50 MB is
// treated as junk and ignored.
const minVideoBytes = 50 << 20

// First 4-digit year in the filename. Captures 19xx / 20xx / 21xx —
// anything past 2199 isn't a film year, and pre-1900 collides with
// release group numerics ("AVC1" → 1xxx).
var yearPattern = regexp.MustCompile(`\b(19\d{2}|20\d{2}|21\d{2})\b`)

// ParseResult is what we extract from one filename. Year is 0 when no
// 4-digit year was found — the TMDB search then runs unfiltered and
// we take the best result regardless of year.
type ParseResult struct {
	Title string
	Year  int
}

// ParseFilename peels the title + year out of a video filename. The
// input is the basename (no directory). Common shapes handled:
//
//	"Inception (2010) [1080p BluRay x264].mkv"   → Inception, 2010
//	"Inception.2010.1080p.BluRay.x264.mkv"        → Inception, 2010
//	"The.Matrix.1999.UHD.HDR.x265-GROUP.mkv"      → The Matrix, 1999
//	"Tenet 2020 1080p.mkv"                        → Tenet, 2020
//	"Some Movie.mkv"                              → Some Movie, 0
//
// The year is the FIRST 4-digit year found. Everything before it is
// the title (with dots / underscores collapsed into spaces). When no
// year is found we use the whole basename minus the extension.
func ParseFilename(name string) ParseResult {
	stem := strings.TrimSuffix(name, filepath.Ext(name))

	idx := yearPattern.FindStringIndex(stem)
	if idx == nil {
		return ParseResult{Title: cleanTitle(stem)}
	}
	yearStr := stem[idx[0]:idx[1]]
	year, _ := strconv.Atoi(yearStr)

	rawTitle := stem[:idx[0]]
	return ParseResult{Title: cleanTitle(rawTitle), Year: year}
}

// cleanTitle turns "The.Matrix" / "the_matrix" / "The  Matrix  " into
// "The Matrix". Trailing dashes and brackets from release-group
// suffixes are dropped.
func cleanTitle(raw string) string {
	s := raw
	s = strings.ReplaceAll(s, ".", " ")
	s = strings.ReplaceAll(s, "_", " ")
	// Strip leading/trailing bracket noise (e.g. "[GroupName]Movie")
	s = strings.Trim(s, "()[]{}- \t")
	// Collapse runs of whitespace.
	s = strings.Join(strings.Fields(s), " ")
	return s
}

// -----------------------------------------------------------------------------
// Scan orchestration
// -----------------------------------------------------------------------------

// ScanReport is returned by Scan to the caller. Surfaced in the API
// response so the settings UI can show "X matched, Y unmatched, took
// Zms".
type ScanReport struct {
	StartedAt   time.Time `json:"startedAt"`
	FinishedAt  time.Time `json:"finishedAt"`
	Directory   string    `json:"directory"`
	FilesSeen   int       `json:"filesSeen"`
	Matched     int       `json:"matched"`
	Unmatched   int       `json:"unmatched"`
	DurationMs  int64     `json:"durationMs"`
	Removed     int       `json:"removed"`
	WalkError   string    `json:"walkError,omitempty"`
}

// TMDBSearcher is the slice of *tmdb.Client we actually use. Defined
// as an interface so unit tests can stub it without spinning a real
// HTTP server.
type TMDBSearcher interface {
	Get(ctx context.Context, path string, params url.Values) ([]byte, error)
}

// Scan walks `dir` recursively, parses every video file's name, looks
// each one up on TMDB, and upserts a LocalFile row. Returns a
// ScanReport. Safe to call repeatedly — re-scans update metadata in
// place and remove rows whose path no longer exists.
//
// The TMDB lookups serialise (one at a time) on purpose: TMDB
// rate-limits at 40 req / 10 s per IP, and our own SQLite cache makes
// repeats free anyway. Parallel scanning didn't help on real test
// libraries.
func Scan(ctx context.Context, dir string, t TMDBSearcher, store *db.Database) (*ScanReport, error) {
	report := &ScanReport{
		StartedAt: time.Now(),
		Directory: dir,
	}

	if strings.TrimSpace(dir) == "" {
		return report, fmt.Errorf("scan: empty directory")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return report, fmt.Errorf("scan: resolve abs: %w", err)
	}
	if info, err := os.Stat(abs); err != nil {
		return report, fmt.Errorf("scan: stat %q: %w", abs, err)
	} else if !info.IsDir() {
		return report, fmt.Errorf("scan: %q is not a directory", abs)
	}

	seenPaths := make([]string, 0, 256)

	walkErr := filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Permission denied on a subdir → log and skip, don't fail
			// the whole scan.
			log.Printf("library scan: walk %s: %v", path, err)
			return nil
		}
		if d.IsDir() {
			// Skip well-known noise dirs.
			switch strings.ToLower(d.Name()) {
			case "sample", "samples", "extras", "featurettes", ".trash":
				return filepath.SkipDir
			}
			return nil
		}

		ext := strings.ToLower(filepath.Ext(d.Name()))
		if !videoExtensions[ext] {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() < minVideoBytes {
			return nil
		}

		report.FilesSeen++
		seenPaths = append(seenPaths, path)

		parsed := ParseFilename(d.Name())
		row := &models.LocalFile{
			Path:        path,
			SizeBytes:   info.Size(),
			ScannedAt:   time.Now(),
			ParsedTitle: parsed.Title,
			ParsedYear:  parsed.Year,
			MediaType:   "movie",
		}

		if match, matchErr := matchTMDB(ctx, t, parsed); matchErr == nil && match != nil {
			row.TMDBID = match.ID
			row.Title = match.Title
			row.PosterPath = match.PosterPath
			row.BackdropPath = match.BackdropPath
			row.Overview = match.Overview
			row.Year = extractYear(match.ReleaseDate)
			report.Matched++
		} else {
			report.Unmatched++
			if matchErr != nil {
				log.Printf("library scan: tmdb match failed for %q: %v", parsed.Title, matchErr)
			}
		}

		if _, err := store.UpsertLocalFile(row); err != nil {
			log.Printf("library scan: upsert %s: %v", path, err)
		}
		return nil
	})

	if walkErr != nil {
		report.WalkError = walkErr.Error()
	}

	// Prune rows whose path is no longer present. Only if the walk
	// itself succeeded — otherwise we'd delete everything on a
	// permission glitch.
	if walkErr == nil {
		if removed, derr := store.DeleteLocalFilesNotIn(seenPaths); derr == nil {
			report.Removed = int(removed)
		}
	}

	report.FinishedAt = time.Now()
	report.DurationMs = report.FinishedAt.Sub(report.StartedAt).Milliseconds()
	return report, nil
}

// matchTMDB queries /search/movie with the parsed title (+ year when
// available) and returns the first hit. Returns nil, nil when TMDB
// has no result for the title.
func matchTMDB(ctx context.Context, t TMDBSearcher, parsed ParseResult) (*tmdbMovie, error) {
	if parsed.Title == "" {
		return nil, nil
	}
	q := url.Values{}
	q.Set("query", parsed.Title)
	if parsed.Year > 0 {
		q.Set("year", strconv.Itoa(parsed.Year))
	}
	body, err := t.Get(ctx, "/search/movie", q)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Results []tmdbMovie `json:"results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	if len(resp.Results) == 0 {
		// One more try without the year — rip-named years are often
		// off by one (a 2023 film tagged 2022 because of festival
		// release vs theatrical, etc.).
		if parsed.Year > 0 {
			q.Del("year")
			body, err := t.Get(ctx, "/search/movie", q)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(body, &resp); err != nil {
				return nil, err
			}
		}
		if len(resp.Results) == 0 {
			return nil, nil
		}
	}
	// TMDB sorts by popularity desc; the first result is almost always
	// the right one. Returning &resp.Results[0] would alias the slice
	// in odd ways under future refactors — copy.
	first := resp.Results[0]
	return &first, nil
}

// tmdbMovie is the subset of /search/movie response we actually use.
type tmdbMovie struct {
	ID           int     `json:"id"`
	Title        string  `json:"title"`
	OriginalTitle string `json:"original_title"`
	ReleaseDate  string  `json:"release_date"`
	PosterPath   string  `json:"poster_path"`
	BackdropPath string  `json:"backdrop_path"`
	Overview     string  `json:"overview"`
	Popularity   float64 `json:"popularity"`
}

// extractYear pulls the 4-digit year out of a release_date like
// "2010-07-16". Returns 0 if the date is empty or malformed.
func extractYear(date string) int {
	if len(date) < 4 {
		return 0
	}
	y, err := strconv.Atoi(date[:4])
	if err != nil {
		return 0
	}
	return y
}

// Compile-time assertion: *tmdb.Client satisfies the TMDBSearcher
// interface we use here. If TMDB's Client signature drifts, this
// breaks at compile time instead of at the first scan.
var _ TMDBSearcher = (*tmdb.Client)(nil)
