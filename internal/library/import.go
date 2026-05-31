package library

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"notflix/internal/database/db"
	"notflix/internal/database/models"
	"notflix/internal/torbox"
)

// ImportResult is what ImportTorrentFromBytes returns to the caller —
// same shape exposed by /import-torrent so the HTTP handler can just
// pass it through, and the watcher can log it.
type ImportResult struct {
	TorrentID int      `json:"torrentId"`
	Name      string   `json:"name"`
	Imported  int      `json:"imported"`
	Skipped   int      `json:"skipped"`
	Failed    int      `json:"failed"`
	Errors    []string `json:"errors,omitempty"`
}

// ImportTorrentFromBytes is the shared import path used by both the
// HTTP /import-torrent handler AND the fsnotify TorrentWatcher.
//
// Flow:
//  1. Push the .torrent bytes to TorBox (AddTorrentFile)
//  2. Poll until metadata is ready (90 s budget — most cached torrents
//     reply in 1-3 s)
//  3. For each video file in the torrent:
//      - parse filename + folder hint
//      - match against TMDB
//      - upsert a LocalFile row with source="torbox",
//        path="torbox://<torrentId>/<fileId>"
//
// On torrent-level failure (TorBox refuses, never goes ready) returns
// (nil, err). On per-file failure, the row is counted in Failed/Errors
// but processing continues.
func ImportTorrentFromBytes(
	ctx context.Context,
	content []byte,
	filename string,
	tb *torbox.Client,
	store *db.Database,
	tmdb TMDBSearcher,
) (*ImportResult, error) {
	created, err := tb.AddTorrentFile(ctx, filename, content)
	if err != nil {
		return nil, fmt.Errorf("torbox add: %w", err)
	}

	var ready *torbox.Torrent
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		t, err := tb.GetTorrent(ctx, created.TorrentID)
		if err != nil {
			return nil, fmt.Errorf("torbox poll: %w", err)
		}
		if t.DownloadFinished || t.DownloadPresent || len(t.Files) > 0 {
			ready = t
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	if ready == nil {
		return nil, fmt.Errorf("torbox: torrent not ready after 90s (id=%d)", created.TorrentID)
	}

	result := &ImportResult{
		TorrentID: created.TorrentID,
		Name:      ready.Name,
	}
	// Hint show name extracted from the torrent root (eg.
	// "Demon.Slayer.S04.MULTi.1080p..." → "Demon Slayer") for
	// episode files whose own name lacks the show ("S04E07.mkv").
	hintShowName := FolderShowName(ready.Name)

	for _, f := range ready.Files {
		if !IsVideoFile(f.Name) {
			result.Skipped++
			continue
		}
		base := filepath.Base(f.Name)
		match, err := MatchOneFile(ctx, tmdb, base, hintShowName)
		if err != nil {
			result.Failed++
			if len(result.Errors) < 10 {
				result.Errors = append(result.Errors,
					fmt.Sprintf("%s: %v", base, err))
			}
			continue
		}
		if match == nil {
			result.Skipped++
			continue
		}
		row := &models.LocalFile{
			Path:          fmt.Sprintf("torbox://%d/%d", created.TorrentID, f.ID),
			SizeBytes:     f.Size,
			ScannedAt:     time.Now(),
			Source:        "torbox",
			TorrentID:     created.TorrentID,
			TorrentFileID: f.ID,
			ParsedTitle:   match.ParsedTitle,
			ParsedYear:    match.ParsedYear,
			TMDBID:        match.TMDBID,
			MediaType:     match.MediaType,
			Title:         match.Title,
			PosterPath:    match.PosterPath,
			BackdropPath:  match.BackdropPath,
			Overview:      match.Overview,
			Year:          match.Year,
			Season:        match.Season,
			Episode:       match.Episode,
		}
		if _, err := store.UpsertLocalFile(row); err != nil {
			result.Failed++
			if len(result.Errors) < 10 {
				result.Errors = append(result.Errors,
					fmt.Sprintf("%s: %v", base, err))
			}
			continue
		}
		result.Imported++
	}
	return result, nil
}

// IsVideoFile is exposed so the import + watcher logic doesn't need
// to duplicate the extension list maintained by the scanner.
func IsVideoFile(name string) bool {
	lower := strings.ToLower(name)
	for _, ext := range []string{".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}
