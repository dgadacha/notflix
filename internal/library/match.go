package library

import (
	"context"
)

// MatchedFile is the result of parsing one filename + TMDB lookup.
// Either a movie OR an episode (Season/Episode > 0). TMDBID == 0
// means "no match found" — the caller decides whether to store the
// row anyway or skip.
type MatchedFile struct {
	ParsedTitle  string
	ParsedYear   int
	TMDBID       int
	MediaType    string // "movie" | "tv"
	Title        string
	Year         int
	PosterPath   string
	BackdropPath string
	Overview     string
	Season       int // 0 for movies
	Episode      int // 0 for movies
}

// MatchOneFile parses a video filename, decides movie vs episode
// based on SxxExx presence, queries TMDB, and returns normalised
// metadata.
//
// hintShowName is used for episodes when the filename itself lacks
// the show name (eg. "S01E07.mkv" inside a folder named
// "Demon.Slayer.S01.MULTi"). Pass "" if no hint is available.
//
// Public so the /import-torrent handler can reuse the exact same
// parsing + TMDB matching logic as the on-disk scanner.
func MatchOneFile(ctx context.Context, t TMDBSearcher, filename, hintShowName string) (*MatchedFile, error) {
	// First: is it an episode? (SxxExx / NxNN / etc).
	if ep, ok := ParseEpisode(filename); ok {
		showName := ep.ShowName
		if showName == "" {
			showName = hintShowName
		}
		if showName == "" {
			// No show name at all — return the SxxExx info but no
			// TMDB match. Caller can choose to keep as orphan.
			return &MatchedFile{
				ParsedTitle: filename,
				MediaType:   "tv",
				Season:      ep.Season,
				Episode:     ep.Episode,
			}, nil
		}
		tv, err := matchTMDBTV(ctx, t, showName)
		if err != nil {
			return nil, err
		}
		out := &MatchedFile{
			ParsedTitle: showName,
			MediaType:   "tv",
			Season:      ep.Season,
			Episode:     ep.Episode,
		}
		if tv != nil {
			out.TMDBID = tv.ID
			out.Title = tv.Name
			out.PosterPath = tv.PosterPath
			out.BackdropPath = tv.BackdropPath
			out.Overview = tv.Overview
			out.Year = extractYear(tv.FirstAirDate)
		}
		return out, nil
	}

	// Otherwise treat as a movie. Use the existing filename parser
	// to get title + year.
	parsed := ParseFilename(filename)
	if parsed.Title == "" {
		return nil, nil
	}
	movie, err := matchTMDBMovie(ctx, t, parsed)
	if err != nil {
		return nil, err
	}
	out := &MatchedFile{
		ParsedTitle: parsed.Title,
		ParsedYear:  parsed.Year,
		MediaType:   "movie",
	}
	if movie != nil {
		out.TMDBID = movie.ID
		out.Title = movie.Title
		out.PosterPath = movie.PosterPath
		out.BackdropPath = movie.BackdropPath
		out.Overview = movie.Overview
		out.Year = extractYear(movie.ReleaseDate)
	} else if parsed.Year > 0 {
		out.Year = parsed.Year
	}
	return out, nil
}
