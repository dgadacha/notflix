package library

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"notflix/internal/database/db"
	"notflix/internal/database/models"
)

// MKV → MP4 batch converter.
//
// Purpose: a lot of release MKVs ship with AC-3 / E-AC-3 / DTS / TrueHD
// audio that Chrome and Firefox can't decode natively. The simplest
// fix is to remux/transmux them to MP4:
//
//	If source audio is AAC      → ffmpeg -c:v copy -c:a copy out.mp4
//	                              (pure container change, seconds)
//	Otherwise (AC-3, DTS, …)    → ffmpeg -c:v copy -c:a aac out.mp4
//	                              (audio transcoded, ~30 s for a 2 h film)
//
// On success, the source .mkv is deleted from disk. The fsnotify
// watcher picks up the new .mp4 immediately and indexes it; the next
// auto-scan removes the dead .mkv row from the DB.
//
// State is package-level on purpose (process-wide single batch job),
// just like the scan runner.

type ConvertProgress struct {
	Running     bool      `json:"running"`
	Total       int       `json:"total"`
	Current     int       `json:"current"`
	CurrentFile string    `json:"currentFile,omitempty"`
	Succeeded   int       `json:"succeeded"`
	Skipped     int       `json:"skipped"` // already a .mp4 sibling exists
	Failed      int       `json:"failed"`
	Errors      []string  `json:"errors,omitempty"`
	StartedAt   time.Time `json:"startedAt,omitempty"`
	FinishedAt  time.Time `json:"finishedAt,omitempty"`
}

var (
	convertMu     sync.RWMutex
	convertState  ConvertProgress
	convertCancel context.CancelFunc
)

// ConvertSnapshot returns a copy of the current batch state.
func ConvertSnapshot() ConvertProgress {
	convertMu.RLock()
	defer convertMu.RUnlock()
	// Deep-copy Errors so the caller can't mutate our slice.
	errs := make([]string, len(convertState.Errors))
	copy(errs, convertState.Errors)
	snap := convertState
	snap.Errors = errs
	return snap
}

// TryStartConvertBatch kicks off a batch in a goroutine. Returns false
// if a batch is already running.
func TryStartConvertBatch(store *db.Database) bool {
	convertMu.Lock()
	if convertState.Running {
		convertMu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	convertCancel = cancel
	convertState = ConvertProgress{
		Running:   true,
		StartedAt: time.Now(),
	}
	convertMu.Unlock()

	go runConvertBatch(ctx, store)
	return true
}

// CancelConvertBatch stops the currently-running batch. No-op if idle.
func CancelConvertBatch() {
	convertMu.Lock()
	defer convertMu.Unlock()
	if convertCancel != nil {
		convertCancel()
	}
}

func runConvertBatch(ctx context.Context, store *db.Database) {
	defer func() {
		convertMu.Lock()
		convertState.Running = false
		convertState.FinishedAt = time.Now()
		convertCancel = nil
		convertMu.Unlock()
	}()

	files, err := store.ListAllLocalFiles()
	if err != nil {
		log.Printf("convert batch: list files: %v", err)
		return
	}

	// Filter to MKVs only (case-insensitive).
	var mkvs []*models.LocalFile
	for _, f := range files {
		if strings.EqualFold(filepath.Ext(f.Path), ".mkv") {
			mkvs = append(mkvs, f)
		}
	}

	convertMu.Lock()
	convertState.Total = len(mkvs)
	convertMu.Unlock()

	if len(mkvs) == 0 {
		log.Printf("convert batch: no MKV files to convert")
		return
	}

	log.Printf("convert batch: %d MKV(s) to process", len(mkvs))

	for i, f := range mkvs {
		if ctx.Err() != nil {
			log.Printf("convert batch: cancelled at %d/%d", i, len(mkvs))
			return
		}
		convertMu.Lock()
		convertState.Current = i + 1
		convertState.CurrentFile = filepath.Base(f.Path)
		convertMu.Unlock()

		outcome, errMsg := convertOne(ctx, f.Path)

		convertMu.Lock()
		switch outcome {
		case "ok":
			convertState.Succeeded++
		case "skipped":
			convertState.Skipped++
		default:
			convertState.Failed++
			if errMsg != "" {
				// Cap error list so it doesn't blow up over a giant batch.
				if len(convertState.Errors) < 20 {
					convertState.Errors = append(convertState.Errors,
						fmt.Sprintf("%s: %s", filepath.Base(f.Path), errMsg))
				}
			}
		}
		convertMu.Unlock()
	}

	convertMu.RLock()
	log.Printf("convert batch: done — %d ok, %d skipped, %d failed",
		convertState.Succeeded, convertState.Skipped, convertState.Failed)
	convertMu.RUnlock()
}

// convertOne does the actual ffmpeg call for one MKV.
//   - Returns "ok"      → conversion succeeded, .mkv deleted
//   - Returns "skipped" → a .mp4 with the same basename already exists
//                         (we don't overwrite, the user can clean up)
//   - Returns "failed"  → ffmpeg/output/delete error; errMsg explains
func convertOne(ctx context.Context, mkvPath string) (outcome, errMsg string) {
	if _, err := os.Stat(mkvPath); err != nil {
		return "failed", "source missing: " + err.Error()
	}

	// Output path = same dir, same basename, .mp4 (handles MKV and mkv).
	ext := filepath.Ext(mkvPath)
	outPath := strings.TrimSuffix(mkvPath, ext) + ".mp4"

	if _, err := os.Stat(outPath); err == nil {
		// Sibling .mp4 already there — don't overwrite. Could be a
		// previous successful conversion that left the .mkv as a
		// leftover; the admin can delete it manually.
		return "skipped", ""
	}

	// Probe the source audio codec so we know whether we can copy or
	// have to re-encode.
	audio := probeAudioCodec(ctx, mkvPath)
	log.Printf("convert: %s (audio=%q)", filepath.Base(mkvPath), audio)

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-y", // we already checked outPath doesn't exist; -y avoids the prompt
		"-i", mkvPath,
		"-c:v", "copy", // bit-perfect video copy
		"-map_metadata", "0",
		"-map", "0:v:0",
		"-map", "0:a:0",
	}
	if strings.EqualFold(audio, "aac") {
		// Pure container change. Should take a few seconds for any
		// size; ffmpeg is just rewriting MP4 boxes.
		args = append(args, "-c:a", "copy")
	} else {
		// Transcode audio to AAC stereo 192 kb/s. Quick (a few seconds
		// of audio per second of wall time on a modern CPU).
		args = append(args, "-c:a", "aac", "-b:a", "192k", "-ac", "2")
	}
	args = append(args,
		// faststart moves the moov to the front so the browser can
		// start playback before the whole file downloads.
		"-movflags", "+faststart",
		outPath,
	)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// Tidy up the partial / corrupt output.
		_ = os.Remove(outPath)
		if ctx.Err() != nil {
			return "failed", "cancelled"
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		return "failed", msg
	}

	// Sanity check the output.
	info, err := os.Stat(outPath)
	if err != nil || info.Size() == 0 {
		_ = os.Remove(outPath)
		return "failed", "ffmpeg produced no output"
	}

	// Delete the source MKV. If this fails, we still consider the
	// conversion successful — the MP4 is valid; the user can clean up
	// the MKV manually later.
	if err := os.Remove(mkvPath); err != nil {
		log.Printf("convert: removed %s mp4 but couldn't delete .mkv: %v",
			filepath.Base(outPath), err)
	}

	return "ok", ""
}

// probeAudioCodec returns the first audio stream's codec name (lower
// case, eg "aac" / "ac3" / "eac3" / "dts" / "truehd"), or "" if
// ffprobe fails. Used to pick between -c:a copy and -c:a aac.
func probeAudioCodec(ctx context.Context, path string) string {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=codec_name",
		"-of", "default=noprint_wrappers=1:nokey=1",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.ToLower(string(out)))
}
