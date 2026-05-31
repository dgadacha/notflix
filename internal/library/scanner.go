// Package library scans a local directory for video files, parses
// their filenames into (title, year) for movies or (show, season,
// episode) for series, looks each up on TMDB, and persists the result
// as a LocalFile row. The frontend renders these as a "Bibliothèque
// locale" home rail; clicking a card plays the file directly from
// disk via /api/v1/local-library/stream/:id — no Prowlarr, no TorBox.
//
// Layout supported (typical user library):
//
//	library/
//	├── Movie.2024.1080p.GROUP/
//	│   └── Movie.2024.1080p.GROUP.mkv          (folder-as-movie)
//	├── Series.S01.1080p.GROUP/
//	│   ├── Series.S01E01.1080p.mkv             (TV season folder)
//	│   ├── Series.S01E02.1080p.mkv
//	│   └── …
//	├── Some.Other.Movie.2025.mkv                (orphan movie at root)
//	└── Sample/                                  (skipped — noise dir)
//
// Episode parsing handles both SxxExx and 1x05 patterns. Show name is
// taken from the folder name (everything before the SxxExx marker).
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
	"sync"
	"time"

	"notflix/internal/database/db"
	"notflix/internal/database/models"
	"notflix/internal/tmdb"
)

// Playable video extensions. Anything else (subs, nfo, sample.jpg,
// readme.txt) is silently skipped.
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

// Files below this size are treated as junk (release-group "Sample"
// teasers ship ~5-50 KB, the actual film is 1-50 GB).
const minVideoBytes = 50 << 20

// First 4-digit year in the filename / foldername. 19xx / 20xx / 21xx
// only — release-group hex sequences ("AVC1") otherwise hit on year=1.
var yearPattern = regexp.MustCompile(`\b(19\d{2}|20\d{2}|21\d{2})\b`)

// SxxExx or SxxxExxx — case-insensitive, captures (season, episode).
var seasonEpisodeSExEPattern = regexp.MustCompile(`(?i)\bS(\d{1,3})E(\d{1,3})\b`)

// 1x05 / 12x05 — alternative episode notation common on anime / older
// rips. Captures (season, episode).
var seasonEpisodeXPattern = regexp.MustCompile(`\b(\d{1,2})x(\d{2})\b`)

// Season-only pattern, e.g. "Show.S02.GROUP" — used on TV season
// folders that don't repeat SxxExx in the folder name itself.
var seasonOnlyPattern = regexp.MustCompile(`(?i)\bS(\d{1,3})\b`)

// Natural-language season pattern for folder names that spell the
// word out:
//
//   "Show.Saison.3.GROUP"           → 3
//   "Show Season 4"                 → 4
//   "Show.Series.2.1080p"           → 2
//   "Show - Saison 03"              → 3
//   "Show.Temporada.2"              → 2 (Spanish)
//   "Show Stagione 1"               → 1 (Italian)
//   "Show Staffel 5"                → 5 (German)
//
// The separator between the keyword and the number is liberal: dots,
// underscores, dashes, spaces, or any run of non-word characters
// (`\W+`). We also accept the keyword with or without a trailing 's'
// for English (Seasons / Series) since rip-naming is inconsistent.
var seasonWordPattern = regexp.MustCompile(
	`(?i)\b(?:Saisons?|Seasons?|Series|Temporadas?|Stagioni|Stagione|Staffel)\W+(\d{1,3})\b`,
)

// Folder names we never descend into (release-group leftovers,
// trash, behind-the-scenes featurettes — none of these are the main
// film/episode the user wants to play).
var skipFolders = map[string]bool{
	"sample":       true,
	"samples":      true,
	"extras":       true,
	"featurettes":  true,
	"behind the scenes": true,
	"deleted scenes":    true,
	".trash":       true,
	"@eadir":       true, // Synology metadata
}

// ParseResult — output of ParseFilename for movies. Title is the
// cleaned-up basename (or foldername); Year is the 4-digit year or 0
// when no year was found.
type ParseResult struct {
	Title string
	Year  int
}

// ParseFilename peels (title, year) out of a video filename or folder
// name. The first 4-digit year wins; everything before becomes the
// title (dots/underscores replaced with spaces, bracket noise
// stripped). Returns Year=0 when no year is present.
func ParseFilename(name string) ParseResult {
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	idx := yearPattern.FindStringIndex(stem)
	if idx == nil {
		return ParseResult{Title: cleanTitle(stem)}
	}
	yearStr := stem[idx[0]:idx[1]]
	year, _ := strconv.Atoi(yearStr)
	return ParseResult{Title: cleanTitle(stem[:idx[0]]), Year: year}
}

// EpisodeParse — output of ParseEpisode for a TV episode file. ShowName
// is the cleaned-up prefix BEFORE the SxxExx marker; Season+Episode
// are the captured numbers. Returns ok=false when neither pattern
// matched — caller should treat the file as a movie or skip.
type EpisodeParse struct {
	ShowName string
	Season   int
	Episode  int
}

// ParseEpisode tries SxxExx then 1x05 against the filename. Falls back
// to (ok=false) on no match. Show name is everything before the
// matched marker, cleaned.
func ParseEpisode(name string) (EpisodeParse, bool) {
	stem := strings.TrimSuffix(name, filepath.Ext(name))

	if m := seasonEpisodeSExEPattern.FindStringSubmatchIndex(stem); m != nil {
		season, _ := strconv.Atoi(stem[m[2]:m[3]])
		episode, _ := strconv.Atoi(stem[m[4]:m[5]])
		return EpisodeParse{
			ShowName: cleanTitle(stem[:m[0]]),
			Season:   season,
			Episode:  episode,
		}, true
	}
	if m := seasonEpisodeXPattern.FindStringSubmatchIndex(stem); m != nil {
		season, _ := strconv.Atoi(stem[m[2]:m[3]])
		episode, _ := strconv.Atoi(stem[m[4]:m[5]])
		return EpisodeParse{
			ShowName: cleanTitle(stem[:m[0]]),
			Season:   season,
			Episode:  episode,
		}, true
	}
	return EpisodeParse{}, false
}

// ExtractSeasonFromFolder returns the season number if a folder name
// declares one. Handles both plain "Show.S02.GROUP" → 2 AND the
// per-episode subfolder shape "Show.S01E03.GROUP" → 1.
//
// The two-pattern fallback fixes a subtle regex trap: `\bS01\b` does
// NOT match inside "S01E01" because `E` is a word char so there's no
// word boundary between `S01` and `E`. We try the SxxExx form first
// (catches per-episode folder names), then the Sxx-alone form.
func ExtractSeasonFromFolder(name string) int {
	if m := seasonEpisodeSExEPattern.FindStringSubmatch(name); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	if m := seasonOnlyPattern.FindStringSubmatch(name); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	// "Saison.3", "Season 4", "Temporada 2"…
	if m := seasonWordPattern.FindStringSubmatch(name); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return 0
}

// FolderShowName strips the SxxExx (or just Sxx) marker — and
// everything that follows — from a folder name so the remainder is
// just the show title:
//
//	"Euphoria.S01.MULTi.1080p"         → "Euphoria"
//	"Euphoria.S01E03.MULTi.1080p"      → "Euphoria"
//	"Friends Season 2"                 → "Friends Season 2" (no match,
//	                                      whole name kept — user can
//	                                      rename)
func FolderShowName(folder string) string {
	// Pick the EARLIEST marker — for folders that carry multiple
	// (eg. "Show.Saison.3.GROUP" where GROUP happens to contain S01)
	// we want to strip starting from "Saison.3", not from a spurious
	// later SxxExx hit. The three patterns can return different
	// offsets, so compute all three and use the smallest non-nil one.
	earliest := -1
	if idx := seasonEpisodeSExEPattern.FindStringIndex(folder); idx != nil {
		earliest = idx[0]
	}
	if idx := seasonOnlyPattern.FindStringIndex(folder); idx != nil {
		if earliest == -1 || idx[0] < earliest {
			earliest = idx[0]
		}
	}
	if idx := seasonWordPattern.FindStringIndex(folder); idx != nil {
		if earliest == -1 || idx[0] < earliest {
			earliest = idx[0]
		}
	}
	if earliest >= 0 {
		return cleanTitle(folder[:earliest])
	}
	return cleanTitle(folder)
}

func cleanTitle(raw string) string {
	s := raw
	s = strings.ReplaceAll(s, ".", " ")
	s = strings.ReplaceAll(s, "_", " ")
	s = strings.Trim(s, "()[]{}- \t")
	s = strings.Join(strings.Fields(s), " ")
	return s
}

// -----------------------------------------------------------------------------
// Live progress state
// -----------------------------------------------------------------------------

// ProgressSnapshot is the JSON-friendly read-only view of the current
// scan state. Returned by Progress() to the handler layer; unsafe to
// mutate (treat as a value type).
type ProgressSnapshot struct {
	Running     bool   `json:"running"`
	StartedAt   string `json:"startedAt,omitempty"`
	Total       int    `json:"total"`
	Current     int    `json:"current"`
	CurrentFile string `json:"currentFile,omitempty"`
	Matched     int    `json:"matched"`
	Unmatched   int    `json:"unmatched"`
}

type progressState struct {
	mu          sync.RWMutex
	running     bool
	startedAt   time.Time
	total       int
	current     int
	currentFile string
	matched     int
	unmatched   int
}

var globalProgress = &progressState{}

// Progress returns the current scan state as a snapshot. Safe to call
// at any time; the status endpoint hits this every ~1.5 s while a
// scan is running.
func Progress() ProgressSnapshot {
	globalProgress.mu.RLock()
	defer globalProgress.mu.RUnlock()
	startedAt := ""
	if !globalProgress.startedAt.IsZero() {
		startedAt = globalProgress.startedAt.Format(time.RFC3339)
	}
	return ProgressSnapshot{
		Running:     globalProgress.running,
		StartedAt:   startedAt,
		Total:       globalProgress.total,
		Current:     globalProgress.current,
		CurrentFile: globalProgress.currentFile,
		Matched:     globalProgress.matched,
		Unmatched:   globalProgress.unmatched,
	}
}

func (p *progressState) reset(total int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running = true
	p.startedAt = time.Now()
	p.total = total
	p.current = 0
	p.currentFile = ""
	p.matched = 0
	p.unmatched = 0
}

// setTotal patches the total mid-scan. Used between the pre-walk
// (which counts files) and the main pass (which processes them) —
// `reset(0)` flips the running flag immediately, `setTotal(N)` fills
// in the denominator a moment later.
func (p *progressState) setTotal(total int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.total = total
}

func (p *progressState) tick(file string, matched bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current++
	p.currentFile = file
	if matched {
		p.matched++
	} else {
		p.unmatched++
	}
}

func (p *progressState) finish() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running = false
	p.currentFile = ""
}

// -----------------------------------------------------------------------------
// Scan orchestration
// -----------------------------------------------------------------------------

// ScanReport — returned once the scan finishes, surfaced in the API
// response so the settings UI can show the post-scan summary card.
type ScanReport struct {
	StartedAt  time.Time `json:"startedAt"`
	FinishedAt time.Time `json:"finishedAt"`
	Directory  string    `json:"directory"`
	FilesSeen  int       `json:"filesSeen"`
	Matched    int       `json:"matched"`
	Unmatched  int       `json:"unmatched"`
	Movies     int       `json:"movies"`
	Episodes   int       `json:"episodes"`
	DurationMs int64     `json:"durationMs"`
	Removed    int       `json:"removed"`
	WalkError  string    `json:"walkError,omitempty"`
	// Torrent sweep stats — populated only when the manual scan
	// chains a sweep of the .torrent drop dir.
	TorrentsProcessed int      `json:"torrentsProcessed,omitempty"` // .torrent files seen
	TorrentsImported  int      `json:"torrentsImported,omitempty"`  // LocalFile rows added across all torrents
	TorrentsFailed    int      `json:"torrentsFailed,omitempty"`
	TorrentErrors     []string `json:"torrentErrors,omitempty"`
}

// TMDBSearcher is the slice of *tmdb.Client we actually use.
type TMDBSearcher interface {
	Get(ctx context.Context, path string, params url.Values) ([]byte, error)
}

// Scan walks `dir`, classifies each top-level entry, parses + matches
// against TMDB, and upserts a LocalFile row per video file. Cleans up
// rows whose path no longer exists. Updates the package-level
// progress state throughout so the settings UI can render a live bar.
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

	// Flip the running flag IMMEDIATELY — even before the pre-walk,
	// which can take a few seconds on big libraries. Without this, the
	// frontend polls /scan/status during the pre-walk window and sees
	// running=false, so the progress bar takes its time to appear.
	globalProgress.reset(0)
	defer globalProgress.finish()

	// Phase 1: pre-walk to count target files. Fast — just stat each
	// entry, no TMDB. Lets the UI render a real "X / Y" progress bar
	// once it lands.
	total := countVideoFiles(abs)
	globalProgress.setTotal(total)

	// Phase 2: classify top-level entries and process.
	seenPaths := make([]string, 0, total)
	classifyErr := classifyAndProcess(ctx, t, store, abs, &seenPaths, report)
	if classifyErr != nil {
		report.WalkError = classifyErr.Error()
	}

	// Phase 3: prune rows whose path is no longer present. Only when
	// the walk succeeded; a permission glitch shouldn't wipe the DB.
	if classifyErr == nil {
		if removed, derr := store.DeleteLocalFilesNotIn(seenPaths); derr == nil {
			report.Removed = int(removed)
		}
	}

	report.FinishedAt = time.Now()
	report.DurationMs = report.FinishedAt.Sub(report.StartedAt).Milliseconds()
	return report, nil
}

// countVideoFiles does a cheap pre-walk (no TMDB, no upsert) just to
// count files we'll actually process. Excludes Sample folders + tiny
// junk files so the progress bar's denominator matches what the main
// pass will process. Errors are swallowed — worst case the bar
// over- or under-estimates by a few percent.
func countVideoFiles(root string) int {
	count := 0
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipFolders[strings.ToLower(d.Name())] {
				return filepath.SkipDir
			}
			return nil
		}
		if !videoExtensions[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() < minVideoBytes {
			return nil
		}
		count++
		return nil
	})
	return count
}

// classifyAndProcess inspects each top-level entry under root and
// dispatches to processFile (root-level file) or processFolder
// (subfolder).
func classifyAndProcess(
	ctx context.Context,
	t TMDBSearcher,
	store *db.Database,
	root string,
	seenPaths *[]string,
	report *ScanReport,
) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}

	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if e.IsDir() {
			if skipFolders[strings.ToLower(e.Name())] {
				continue
			}
			processFolder(ctx, t, store, filepath.Join(root, e.Name()), e.Name(), seenPaths, report)
			continue
		}
		// Root-level file: treat as movie if it's a playable video.
		if !videoExtensions[strings.ToLower(filepath.Ext(e.Name()))] {
			continue
		}
		fullPath := filepath.Join(root, e.Name())
		info, ierr := os.Stat(fullPath)
		if ierr != nil || info.Size() < minVideoBytes {
			continue
		}
		processMovieFile(ctx, t, store, fullPath, info, "", seenPaths, report)
	}
	return nil
}

// videoEntry is a tiny tuple — promoted to package scope so
// processFolder and processTVFolder share the same type, otherwise Go
// treats two identical anonymous struct definitions as incompatible.
type videoEntry struct {
	path string
	info os.FileInfo
	name string
}

// processFolder picks between TV-season-folder and movie-folder
// strategies based on the contents:
//
//   - If the folder name carries an Sxx marker AND at least one inner
//     file matches SxxExx → TV season folder, each video file is an
//     episode.
//   - Otherwise → movie folder, every video file is treated as the
//     main feature (usually only 1; multi-file movies = part1/part2
//     are rare enough that we don't dedupe).
//
// TMDB search runs ONCE for the TV show (folder-level), then each
// episode reuses that match — saves one HTTP call per episode and
// guarantees all episodes of the same season land on the same show id.
func processFolder(
	ctx context.Context,
	t TMDBSearcher,
	store *db.Database,
	folderPath, folderName string,
	seenPaths *[]string,
	report *ScanReport,
) {
	folderSeason := ExtractSeasonFromFolder(folderName)

	// TV mode: this folder declares a season (either "Show.S01.GROUP"
	// or "Show.S01E03.GROUP" for per-episode folders). Walk the WHOLE
	// subtree to gather every video file — handles both layouts:
	//
	//   Show.S01.GROUP/
	//   ├── Show.S01E01.mkv                                 ← direct
	//   ├── Show.S01E02.mkv
	//
	// and
	//
	//   Show.S01.GROUP/
	//   ├── Show.S01E01.GROUP/                              ← nested
	//   │   └── Show.S01E01.GROUP.mkv
	//   ├── Show.S01E02.GROUP/
	//   │   └── Show.S01E02.GROUP.mkv
	//
	// One TMDB lookup covers all episodes — the show name comes from
	// the season folder, the (season, episode) numbers from each
	// file's name (with a fallback to the immediate parent folder
	// name for the nested layout).
	if folderSeason > 0 {
		var episodes []videoEntry
		collectVideosRecursive(folderPath, &episodes)
		if len(episodes) > 0 {
			processTVFolder(ctx, t, store, folderName, episodes, seenPaths, report)
			return
		}
		// folderSeason > 0 but no videos — fall through to the
		// normal classification (probably an empty / misnamed folder).
	}

	entries, err := os.ReadDir(folderPath)
	if err != nil {
		log.Printf("library scan: read %s: %v", folderPath, err)
		return
	}

	// Collect the playable video files inside.
	var videos []videoEntry
	for _, e := range entries {
		if e.IsDir() {
			if skipFolders[strings.ToLower(e.Name())] {
				continue
			}
			// Recurse for nested layouts — eg. "Movies/Action/Film.mkv"
			// where Movies/ isn't itself a Sxx folder.
			processFolder(ctx, t, store, filepath.Join(folderPath, e.Name()), e.Name(), seenPaths, report)
			continue
		}
		if !videoExtensions[strings.ToLower(filepath.Ext(e.Name()))] {
			continue
		}
		fullPath := filepath.Join(folderPath, e.Name())
		info, ierr := os.Stat(fullPath)
		if ierr != nil || info.Size() < minVideoBytes {
			continue
		}
		videos = append(videos, videoEntry{path: fullPath, info: info, name: e.Name()})
	}

	// Movie folder. The filename inside usually carries the title too;
	// fall back to the folder name when the file is a bare "movie.mkv".
	for _, v := range videos {
		processMovieFile(ctx, t, store, v.path, v.info, folderName, seenPaths, report)
	}
}

// collectVideosRecursive walks `dir` depth-first, appending every
// playable video file (above the minimum size, not under a skip
// folder) into `out`. Used by the TV mode of processFolder to gather
// episodes from both flat and per-episode-subfolder layouts in one
// pass.
func collectVideosRecursive(dir string, out *[]videoEntry) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			if skipFolders[strings.ToLower(e.Name())] {
				continue
			}
			collectVideosRecursive(filepath.Join(dir, e.Name()), out)
			continue
		}
		if !videoExtensions[strings.ToLower(filepath.Ext(e.Name()))] {
			continue
		}
		full := filepath.Join(dir, e.Name())
		info, ierr := os.Stat(full)
		if ierr != nil || info.Size() < minVideoBytes {
			continue
		}
		*out = append(*out, videoEntry{path: full, info: info, name: e.Name()})
	}
}

// processTVFolder ties every episode inside the folder to the same
// TMDB show by searching ONCE on the folder's show name, then
// upserting one LocalFile per episode with season + episode set.
func processTVFolder(
	ctx context.Context,
	t TMDBSearcher,
	store *db.Database,
	folderName string,
	videos []videoEntry,
	seenPaths *[]string,
	report *ScanReport,
) {
	showName := FolderShowName(folderName)
	// Folder-level season so we can backfill episodes where the file
	// itself only declared an episode number (rare but possible).
	folderSeason := ExtractSeasonFromFolder(folderName)
	tvMatch, _ := matchTMDBTV(ctx, t, showName)

	for _, v := range videos {
		ep, ok := ParseEpisode(v.name)
		if !ok {
			// Per-episode-subfolder layout: the file is a bare
			// "movie.mkv" but its immediate parent folder name has
			// the SxxExx marker. Try that.
			parentName := filepath.Base(filepath.Dir(v.path))
			ep, ok = ParseEpisode(parentName)
		}
		if !ok {
			// Still nothing — file plays but season/episode are
			// unknown. We tag the row with the folder's season so
			// the show grouping in the rail still works.
			ep = EpisodeParse{ShowName: showName, Season: folderSeason}
		}
		// Backfill season from the folder when the file declared
		// episode-only (e.g. "Show 01.mkv" inside "Show S03").
		if ep.Season == 0 && folderSeason > 0 {
			ep.Season = folderSeason
		}

		row := &models.LocalFile{
			Path:        v.path,
			SizeBytes:   v.info.Size(),
			ScannedAt:   time.Now(),
			ParsedTitle: ep.ShowName,
			MediaType:   "tv",
			Season:      ep.Season,
			Episode:     ep.Episode,
		}
		matched := false
		if tvMatch != nil {
			row.TMDBID = tvMatch.ID
			row.Title = tvMatch.Name
			row.PosterPath = tvMatch.PosterPath
			row.BackdropPath = tvMatch.BackdropPath
			row.Overview = tvMatch.Overview
			row.Year = extractYear(tvMatch.FirstAirDate)
			matched = true
		}
		if matched {
			report.Matched++
			report.Episodes++
		} else {
			report.Unmatched++
		}
		report.FilesSeen++

		if _, err := store.UpsertLocalFile(row); err != nil {
			log.Printf("library scan: upsert %s: %v", v.path, err)
		}
		*seenPaths = append(*seenPaths, v.path)
		globalProgress.tick(filepath.Base(v.path), matched)
	}
}

// processMovieFile handles one movie video file. folderHint is the
// containing folder name (when called from processFolder) so we have
// a fallback title source if the filename itself is a bare
// "movie.mkv".
func processMovieFile(
	ctx context.Context,
	t TMDBSearcher,
	store *db.Database,
	path string,
	info os.FileInfo,
	folderHint string,
	seenPaths *[]string,
	report *ScanReport,
) {
	parsed := ParseFilename(filepath.Base(path))
	// If the filename parse came up empty (a bare "movie.mkv" inside
	// a "Title.2024.GROUP" folder), fall back to the folder name.
	if (parsed.Title == "" || parsed.Year == 0) && folderHint != "" {
		alt := ParseFilename(folderHint)
		if parsed.Title == "" {
			parsed.Title = alt.Title
		}
		if parsed.Year == 0 {
			parsed.Year = alt.Year
		}
	}

	row := &models.LocalFile{
		Path:        path,
		SizeBytes:   info.Size(),
		ScannedAt:   time.Now(),
		ParsedTitle: parsed.Title,
		ParsedYear:  parsed.Year,
		MediaType:   "movie",
	}
	matched := false
	if match, _ := matchTMDBMovie(ctx, t, parsed); match != nil {
		row.TMDBID = match.ID
		row.Title = match.Title
		row.PosterPath = match.PosterPath
		row.BackdropPath = match.BackdropPath
		row.Overview = match.Overview
		row.Year = extractYear(match.ReleaseDate)
		matched = true
	}
	if matched {
		report.Matched++
		report.Movies++
	} else {
		report.Unmatched++
	}
	report.FilesSeen++

	if _, err := store.UpsertLocalFile(row); err != nil {
		log.Printf("library scan: upsert %s: %v", path, err)
	}
	*seenPaths = append(*seenPaths, path)
	globalProgress.tick(filepath.Base(path), matched)
}

// -----------------------------------------------------------------------------
// TMDB matching
// -----------------------------------------------------------------------------

type tmdbMovie struct {
	ID           int     `json:"id"`
	Title        string  `json:"title"`
	ReleaseDate  string  `json:"release_date"`
	PosterPath   string  `json:"poster_path"`
	BackdropPath string  `json:"backdrop_path"`
	Overview     string  `json:"overview"`
	Popularity   float64 `json:"popularity"`
}

type tmdbTV struct {
	ID           int     `json:"id"`
	Name         string  `json:"name"`
	FirstAirDate string  `json:"first_air_date"`
	PosterPath   string  `json:"poster_path"`
	BackdropPath string  `json:"backdrop_path"`
	Overview     string  `json:"overview"`
	Popularity   float64 `json:"popularity"`
}

func matchTMDBMovie(ctx context.Context, t TMDBSearcher, parsed ParseResult) (*tmdbMovie, error) {
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
	// Retry without the year — rip-named years are often off by one
	// (festival vs theatrical release).
	if len(resp.Results) == 0 && parsed.Year > 0 {
		q.Del("year")
		body, err = t.Get(ctx, "/search/movie", q)
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
	r := resp.Results[0]
	return &r, nil
}

func matchTMDBTV(ctx context.Context, t TMDBSearcher, showName string) (*tmdbTV, error) {
	if showName == "" {
		return nil, nil
	}
	q := url.Values{}
	q.Set("query", showName)
	body, err := t.Get(ctx, "/search/tv", q)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Results []tmdbTV `json:"results"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	if len(resp.Results) == 0 {
		return nil, nil
	}
	r := resp.Results[0]
	return &r, nil
}

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

// Compile-time assertion: *tmdb.Client satisfies our interface.
var _ TMDBSearcher = (*tmdb.Client)(nil)
