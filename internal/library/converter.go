package library

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
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
	// Mode describes what the current batch is doing — "convert" for
	// MKV→MP4 transcode, "reorder" for the lighter audio-track
	// remap-only pass on existing MP4s. The frontend uses this to
	// label its progress card correctly.
	Mode        string    `json:"mode,omitempty"`
	Total       int       `json:"total"`
	Current     int       `json:"current"`
	CurrentFile string    `json:"currentFile,omitempty"`
	// Per-file progress, populated by parsing ffmpeg's -progress
	// output. Pct is 0-100; SecDone / SecTotal are floats in
	// seconds so the UI can render "01:23 / 02:14:08" if wanted.
	// Reset to 0 between files.
	CurrentFilePct float64  `json:"currentFilePct,omitempty"`
	CurrentFileSec float64  `json:"currentFileSec,omitempty"`
	CurrentFileDur float64  `json:"currentFileDur,omitempty"`
	Succeeded      int      `json:"succeeded"`
	Skipped        int      `json:"skipped"` // already a .mp4 sibling exists
	Failed         int      `json:"failed"`
	Errors         []string `json:"errors,omitempty"`
	StartedAt      time.Time `json:"startedAt,omitempty"`
	FinishedAt     time.Time `json:"finishedAt,omitempty"`
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
//
// pickLang (optional, may be nil) lets the caller decide which audio
// language to put first per file. Used to play films in VF and anime
// in VO from the same library — without re-encoding, just by
// reordering the audio map.
func TryStartConvertBatch(store *db.Database, pickLang func(*models.LocalFile) string) bool {
	convertMu.Lock()
	if convertState.Running {
		convertMu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	convertCancel = cancel
	convertState = ConvertProgress{
		Running:   true,
		Mode:      "convert",
		StartedAt: time.Now(),
	}
	convertMu.Unlock()

	go runConvertBatch(ctx, store, pickLang)
	return true
}

// TryStartReorderBatch starts a "reorder audio tracks" batch on the
// already-converted .mp4 files in the library. Same mutex / progress
// state as the convert batch — only one of either runs at a time.
//
// The reorder pass is lightweight: ffmpeg -c copy with a new -map
// order. No re-encoding. A file already in the desired order is
// skipped (we just compare track 0's lang to the picker's choice).
func TryStartReorderBatch(store *db.Database, pickLang func(*models.LocalFile) string) bool {
	if pickLang == nil {
		return false
	}
	convertMu.Lock()
	if convertState.Running {
		convertMu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	convertCancel = cancel
	convertState = ConvertProgress{
		Running:   true,
		Mode:      "reorder",
		StartedAt: time.Now(),
	}
	convertMu.Unlock()

	go runReorderBatch(ctx, store, pickLang)
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

func runConvertBatch(ctx context.Context, store *db.Database, pickLang func(*models.LocalFile) string) {
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
		convertState.CurrentFilePct = 0
		convertState.CurrentFileSec = 0
		convertState.CurrentFileDur = 0
		convertMu.Unlock()

		// Decide audio order per file. nil picker = leave order
		// untouched (legacy behaviour).
		preferredLang := ""
		if pickLang != nil {
			preferredLang = pickLang(f)
		}

		outcome, errMsg := convertOne(ctx, f.Path, preferredLang)

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
// runReorderBatch walks every .mp4 row in the DB and remuxes those
// whose track 0 audio doesn't match the picker's choice. Identical
// progress state to runConvertBatch so the frontend renders the same
// ConvertProgressBar.
func runReorderBatch(ctx context.Context, store *db.Database, pickLang func(*models.LocalFile) string) {
	defer func() {
		convertMu.Lock()
		convertState.Running = false
		convertState.FinishedAt = time.Now()
		convertCancel = nil
		convertMu.Unlock()
	}()

	files, err := store.ListAllLocalFiles()
	if err != nil {
		log.Printf("reorder batch: list files: %v", err)
		return
	}

	// Filter to MP4s only.
	var mp4s []*models.LocalFile
	for _, f := range files {
		if strings.EqualFold(filepath.Ext(f.Path), ".mp4") {
			mp4s = append(mp4s, f)
		}
	}

	convertMu.Lock()
	convertState.Total = len(mp4s)
	convertMu.Unlock()

	if len(mp4s) == 0 {
		log.Printf("reorder batch: no MP4 files to process")
		return
	}
	log.Printf("reorder batch: %d MP4(s) to check", len(mp4s))

	for i, f := range mp4s {
		if ctx.Err() != nil {
			log.Printf("reorder batch: cancelled at %d/%d", i, len(mp4s))
			return
		}
		convertMu.Lock()
		convertState.Current = i + 1
		convertState.CurrentFile = filepath.Base(f.Path)
		convertState.CurrentFilePct = 0
		convertMu.Unlock()

		preferredLang := pickLang(f)
		outcome, errMsg := reorderOne(ctx, f.Path, preferredLang)
		log.Printf("reorder: %s — outcome=%s reason=%q (pref=%q)",
			filepath.Base(f.Path), outcome, errMsg, preferredLang)

		convertMu.Lock()
		switch outcome {
		case "ok":
			convertState.Succeeded++
		case "skipped":
			convertState.Skipped++
			// Surface skip reasons too — that's how the user
			// discovers WHY their Demon Slayer didn't get reordered.
			if errMsg != "" && len(convertState.Errors) < 20 {
				convertState.Errors = append(convertState.Errors,
					fmt.Sprintf("[ignoré] %s: %s", filepath.Base(f.Path), errMsg))
			}
		default:
			convertState.Failed++
			if errMsg != "" && len(convertState.Errors) < 20 {
				convertState.Errors = append(convertState.Errors,
					fmt.Sprintf("%s: %s", filepath.Base(f.Path), errMsg))
			}
		}
		convertMu.Unlock()
	}

	convertMu.RLock()
	log.Printf("reorder batch: done — %d ok, %d skipped, %d failed",
		convertState.Succeeded, convertState.Skipped, convertState.Failed)
	convertMu.RUnlock()
}

// reorderOne checks the current audio track 0 of an .mp4 and, if it
// doesn't match the preferred language, remuxes the file with the
// audio tracks in the preferred order. -c copy across the board, no
// re-encode — runs in seconds even on large files.
//
//   - "skipped" : preferred lang already at track 0, or preferred lang
//     not present in the file
//   - "ok"      : successfully remuxed
//   - "failed"  : ffprobe / ffmpeg / rename error
func reorderOne(ctx context.Context, mp4Path, preferredLang string) (outcome, errMsg string) {
	if strings.TrimSpace(preferredLang) == "" {
		return "skipped", "pas de langue préférée"
	}
	if _, err := os.Stat(mp4Path); err != nil {
		return "failed", "source missing: " + err.Error()
	}

	streams := probeAudioStreams(ctx, mp4Path)
	if len(streams) == 0 {
		return "skipped", "aucune piste audio"
	}
	prefLower := strings.ToLower(strings.TrimSpace(preferredLang))

	// Already correct? Compare track 0 to the desired lang.
	if matchLangCode(streams[0].Lang, prefLower) {
		return "skipped", fmt.Sprintf("track 0 déjà en %s", prefLower)
	}
	// Preferred lang in file at all?
	preferredIdx := -1
	for _, s := range streams {
		if matchLangCode(s.Lang, prefLower) {
			preferredIdx = s.Idx
			break
		}
	}
	if preferredIdx < 0 {
		// List the tags we actually saw so the user can debug
		// (eg. tags="fre,und" → un seul stream taggué FR + un sans
		// tag, on aurait peut-être dû matcher l'untagged comme JP).
		tags := make([]string, len(streams))
		for i, s := range streams {
			if s.Lang == "" {
				tags[i] = "(sans tag)"
			} else {
				tags[i] = s.Lang
			}
		}
		return "skipped", fmt.Sprintf("lang %q absente — tags présents : %s",
			prefLower, strings.Join(tags, ", "))
	}

	// Disk space safety — though a -c copy remux uses only the source
	// size temporarily, the .tmp + the source coexist briefly.
	srcInfo, err := os.Stat(mp4Path)
	if err == nil {
		srcBytes := uint64(srcInfo.Size())
		if free := freeBytesAt(filepath.Dir(mp4Path)); free > 0 && free < srcBytes*6/5 {
			return "failed", fmt.Sprintf(
				"espace insuffisant : %s libre, %s requis",
				humanBytes(free), humanBytes(srcBytes*6/5),
			)
		}
	}

	tmpPath := mp4Path + ".reorder.tmp"
	_ = os.Remove(tmpPath)

	// Build the audio map in preferred order.
	audioOrder := []int{preferredIdx}
	for _, s := range streams {
		if s.Idx != preferredIdx {
			audioOrder = append(audioOrder, s.Idx)
		}
	}

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		"-i", mp4Path,
		"-map", "0:v?",
		"-map_metadata", "0",
	}
	for _, idx := range audioOrder {
		args = append(args, "-map", fmt.Sprintf("0:a:%d", idx))
	}
	args = append(args,
		"-map", "0:s?",
		"-c", "copy",
		"-movflags", "+faststart",
		"-f", "mp4",
		tmpPath,
	)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(tmpPath)
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

	info, err := os.Stat(tmpPath)
	if err != nil || info.Size() == 0 {
		_ = os.Remove(tmpPath)
		return "failed", "ffmpeg produced no output"
	}

	// Atomic swap — same name as source, so we replace it in place.
	if err := os.Rename(tmpPath, mp4Path); err != nil {
		_ = os.Remove(tmpPath)
		return "failed", "rename: " + err.Error()
	}
	log.Printf("reorder: %s — audio order [%s], pref=%q",
		filepath.Base(mp4Path), joinInts(audioOrder), preferredLang)
	return "ok", ""
}

func convertOne(ctx context.Context, mkvPath, preferredAudioLang string) (outcome, errMsg string) {
	srcInfo, err := os.Stat(mkvPath)
	if err != nil {
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

	// Disk space check. We need roughly source size in the same
	// directory (video is copy-muxed, audio is re-encoded so size
	// is comparable). Use 1.2× as a safety margin. Skip with a
	// clear error instead of letting ffmpeg churn for minutes only
	// to fail on "No space left on device".
	srcBytes := uint64(srcInfo.Size())
	needBytes := srcBytes * 6 / 5
	if free := freeBytesAt(filepath.Dir(outPath)); free > 0 && free < needBytes {
		return "failed", fmt.Sprintf(
			"espace insuffisant : %s libre, %s requis",
			humanBytes(free), humanBytes(needBytes),
		)
	}

	// Probe both audio and video codecs so we can pick the right
	// flags. Video matters for HEVC: the MP4 brand defaults to
	// `hev1` but Chrome / Safari need `hvc1` to play HEVC tracks.
	audio := probeAudioCodec(ctx, mkvPath)
	video := probeVideoCodec(ctx, mkvPath)
	log.Printf("convert: %s (video=%q audio=%q)",
		filepath.Base(mkvPath), video, audio)

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-y", // we already checked outPath doesn't exist; -y avoids the prompt
		"-i", mkvPath,
		"-c:v", "copy", // bit-perfect video copy
		"-map_metadata", "0",
		"-map", "0:v:0",
	}

	// Audio mapping. We always map ALL audio tracks (no language
	// dropped — keeps VF, VO etc all available), but REORDER so the
	// preferred language lands at a:0. Chrome and Firefox play the
	// first audio track by default, so this means the user's chosen
	// lang plays automatically without any client-side switching.
	//
	// If no preferred lang was provided, or no matching track was
	// found, we fall back to the source order via `-map 0:a?`.
	audioOrder := orderAudioByPreference(ctx, mkvPath, preferredAudioLang)
	if len(audioOrder) > 0 {
		for _, idx := range audioOrder {
			args = append(args, "-map", fmt.Sprintf("0:a:%d", idx))
		}
		log.Printf("convert: %s — audio order [%s], preferred=%q",
			filepath.Base(mkvPath), joinInts(audioOrder), preferredAudioLang)
	} else {
		args = append(args, "-map", "0:a?")
	}

	// Subtitles — map only TEXT-based subtitle streams. MP4 supports
	// mov_text natively; PGS / DVDSUB (bitmap subs from Blu-ray /
	// DVD rips) can't be converted to mov_text so we skip them
	// silently rather than letting ffmpeg fail the whole conversion.
	textSubs := probeTextSubtitleStreams(ctx, mkvPath)
	for _, idx := range textSubs {
		args = append(args, "-map", fmt.Sprintf("0:s:%d", idx))
	}
	if len(textSubs) > 0 {
		args = append(args, "-c:s", "mov_text")
		log.Printf("convert: %s — %d text sub track(s)",
			filepath.Base(mkvPath), len(textSubs))
	}
	// HEVC in MP4 needs the `hvc1` brand to play in Chrome/Safari.
	// Without `-tag:v hvc1`, ffmpeg writes `hev1` which the browsers
	// silently refuse. For non-HEVC sources the tag is auto (avc1
	// for H.264, etc) — only apply it when we know we're on HEVC.
	if isHEVC(video) {
		args = append(args, "-tag:v", "hvc1")
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
	// Write to <outPath>.tmp first, then atomic rename on success.
	// Cheap (same filesystem) and protects against ffmpeg/Notflix
	// crashing mid-mux leaving a corrupt .mp4 that the next batch
	// would treat as "already converted" and skip.
	tmpPath := outPath + ".tmp"
	// In case a previous run left a stale .tmp behind.
	_ = os.Remove(tmpPath)
	args = append(args,
		// faststart moves the moov to the front so the browser can
		// start playback before the whole file downloads.
		"-movflags", "+faststart",
		// `-f mp4` is REQUIRED because we write to <out>.mp4.tmp
		// and ffmpeg can't infer the format from the .tmp extension.
		"-f", "mp4",
		// Stream key=value progress lines to stdout so we can update
		// the per-file progress bar in real time. Includes out_time
		// (HH:MM:SS.mmm) which we divide by the probed source
		// duration to get a percentage.
		"-progress", "pipe:1",
		"-nostats",
		tmpPath,
	)

	// Pre-fetch the source duration so we can compute "%" from
	// ffmpeg's reported out_time. Best-effort: if ffprobe fails the
	// per-file bar just stays at 0 and the global N/total works fine.
	srcDuration := probeDuration(ctx, mkvPath)
	if srcDuration > 0 {
		convertMu.Lock()
		convertState.CurrentFileDur = srcDuration
		convertMu.Unlock()
	}

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, pipeErr := cmd.StdoutPipe()
	if pipeErr != nil {
		return "failed", "stdout pipe: " + pipeErr.Error()
	}

	if err := cmd.Start(); err != nil {
		return "failed", "ffmpeg start: " + err.Error()
	}

	// Stream progress in a goroutine until ffmpeg closes stdout
	// (i.e. exits). We sync the goroutine end with cmd.Wait() via
	// the `done` channel so progressState updates never race with
	// the post-Wait cleanup.
	done := make(chan struct{})
	go streamConvertProgress(stdout, srcDuration, done)

	waitErr := cmd.Wait()
	<-done

	if waitErr != nil {
		_ = os.Remove(tmpPath)
		if ctx.Err() != nil {
			return "failed", "cancelled"
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		return "failed", msg
	}

	// Sanity check the temp output.
	info, err := os.Stat(tmpPath)
	if err != nil || info.Size() == 0 {
		_ = os.Remove(tmpPath)
		return "failed", "ffmpeg produced no output"
	}

	// Atomic rename → the .mp4 only exists once it's fully valid.
	if err := os.Rename(tmpPath, outPath); err != nil {
		_ = os.Remove(tmpPath)
		return "failed", "rename .tmp → .mp4 failed: " + err.Error()
	}

	// Delete the source MKV. If this fails, we still consider the
	// conversion successful — the MP4 is valid; the user can clean up
	// the MKV manually later.
	srcMB := info.Size() >> 20
	if err := os.Remove(mkvPath); err != nil {
		log.Printf("convert: removed %s mp4 but couldn't delete .mkv: %v",
			filepath.Base(outPath), err)
	} else {
		log.Printf("convert: %s done (%d MB freed)",
			filepath.Base(outPath), srcMB)
	}

	return "ok", ""
}

// probeAudioCodec returns the first audio stream's codec name (lower
// case, eg "aac" / "ac3" / "eac3" / "dts" / "truehd"), or "" if
// ffprobe fails. Used to pick between -c:a copy and -c:a aac.
func probeAudioCodec(ctx context.Context, path string) string {
	return probeFirstStreamCodec(ctx, path, "a:0")
}

// probeVideoCodec returns the first video stream's codec name (lower
// case, eg "h264" / "hevc" / "av1"). Drives the HEVC brand fix
// (`-tag:v hvc1`) inside convertOne.
func probeVideoCodec(ctx context.Context, path string) string {
	return probeFirstStreamCodec(ctx, path, "v:0")
}

func probeFirstStreamCodec(ctx context.Context, path, selector string) string {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", selector,
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

// isHEVC matches the ffprobe names for H.265 / HEVC streams. ffprobe
// usually reports "hevc" but some builds say "h265" — accept both.
func isHEVC(codec string) bool {
	c := strings.ToLower(codec)
	return c == "hevc" || c == "h265" || c == "h.265"
}

// orderAudioByPreference returns the audio-stream indices (a:N) in
// the order they should be muxed into the output MP4. The preferred
// language (ISO 639-2 code) lands at a:0; the rest follow in source
// order.
//
// Returns nil if:
//   - preferredLang is empty (caller falls back to `-map 0:a?`)
//   - ffprobe fails or finds no audio
// In both cases the caller proceeds with default source ordering.
func orderAudioByPreference(ctx context.Context, path, preferredLang string) []int {
	if strings.TrimSpace(preferredLang) == "" {
		return nil
	}
	streams := probeAudioStreams(ctx, path)
	if len(streams) == 0 {
		return nil
	}
	prefLower := strings.ToLower(strings.TrimSpace(preferredLang))
	preferredIdx := -1
	for _, s := range streams {
		if matchLangCode(s.Lang, prefLower) {
			preferredIdx = s.Idx
			break
		}
	}
	if preferredIdx < 0 {
		// Preferred language not present in this file. Leave source
		// order alone — telling the caller to use `-map 0:a?`.
		return nil
	}
	out := make([]int, 0, len(streams))
	out = append(out, preferredIdx)
	for _, s := range streams {
		if s.Idx != preferredIdx {
			out = append(out, s.Idx)
		}
	}
	return out
}

type audioStreamInfo struct {
	Idx  int
	Lang string
	Codec string
}

// probeAudioStreams returns one entry per audio stream in source order
// (a:0 first, a:1 second, …). Lang is the ISO code from the stream's
// language tag, lower-cased, or "" if untagged.
func probeAudioStreams(ctx context.Context, path string) []audioStreamInfo {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "a",
		"-show_entries", "stream=codec_name:stream_tags=language",
		"-of", "json",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var probe struct {
		Streams []struct {
			CodecName string `json:"codec_name"`
			Tags      struct {
				Language string `json:"language"`
			} `json:"tags"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil
	}
	res := make([]audioStreamInfo, 0, len(probe.Streams))
	for i, s := range probe.Streams {
		res = append(res, audioStreamInfo{
			Idx:   i,
			Lang:  strings.ToLower(strings.TrimSpace(s.Tags.Language)),
			Codec: strings.ToLower(s.CodecName),
		})
	}
	return res
}

// matchLangCode is forgiving across the two ISO 639 variants. ffmpeg
// usually writes 639-2/B ("fre"/"ger"/"jpn") but some encoders use
// 639-2/T ("fra"/"deu"/"jpn") or 639-1 ("fr"/"de"/"ja").
func matchLangCode(streamLang, want string) bool {
	if streamLang == "" || want == "" {
		return false
	}
	if streamLang == want {
		return true
	}
	// Alias map: code (any of these) → all of these.
	aliases := [][]string{
		{"fre", "fra", "fr"},
		{"eng", "en"},
		{"jpn", "ja"},
		{"spa", "es"},
		{"ger", "deu", "de"},
		{"ita", "it"},
		{"chi", "zho", "zh"},
		{"kor", "ko"},
		{"por", "pt"},
		{"rus", "ru"},
	}
	for _, group := range aliases {
		inWant := false
		inStream := false
		for _, code := range group {
			if code == want {
				inWant = true
			}
			if code == streamLang {
				inStream = true
			}
		}
		if inWant && inStream {
			return true
		}
	}
	return false
}

func joinInts(xs []int) string {
	parts := make([]string, len(xs))
	for i, x := range xs {
		parts[i] = strconv.Itoa(x)
	}
	return strings.Join(parts, ",")
}

// probeTextSubtitleStreams returns the subtitle-stream indices (s:N)
// that are text-based and can therefore be remuxed to mov_text inside
// an MP4 container.
//
// Skipped codecs:
//   - hdmv_pgs_subtitle (PGS — Blu-ray bitmaps)
//   - dvd_subtitle      (VobSub — DVD bitmaps)
//   - dvb_subtitle      (TV-broadcast bitmaps)
//
// Kept codecs: subrip (srt), ass / ssa, mov_text, webvtt, text.
//
// Returning a per-subtitle-stream index (not a global stream index)
// matches ffmpeg's `-map 0:s:N` selector syntax.
func probeTextSubtitleStreams(ctx context.Context, path string) []int {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "s",
		"-show_entries", "stream=codec_name",
		"-of", "json",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var probe struct {
		Streams []struct {
			CodecName string `json:"codec_name"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil
	}
	textCodecs := map[string]bool{
		"subrip":   true,
		"srt":      true,
		"ass":      true,
		"ssa":      true,
		"mov_text": true,
		"webvtt":   true,
		"text":     true,
	}
	var indices []int
	for i, s := range probe.Streams {
		if textCodecs[strings.ToLower(s.CodecName)] {
			indices = append(indices, i)
		}
	}
	return indices
}

// freeBytesAt returns the number of bytes available to a non-root
// user on the filesystem that hosts `path`. Returns 0 if the call
// fails (caller treats that as "unknown" and proceeds).
//
// Works on macOS + Linux via syscall.Statfs_t. Windows would need
// a different code path but Notflix doesn't deploy there.
func freeBytesAt(path string) uint64 {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0
	}
	// Bavail = blocks free to a non-root user. Bsize = block size.
	// Cast Bsize through int64 → uint64 since its underlying type
	// is int32 on Linux and int32 on macOS.
	return stat.Bavail * uint64(stat.Bsize)
}

// probeDuration returns the source duration in seconds, or 0 if
// ffprobe fails. Used to scale the per-file progress percentage.
func probeDuration(ctx context.Context, path string) float64 {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		return 0
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		return 0
	}
	return v
}

// streamConvertProgress reads ffmpeg's `-progress pipe:1` output
// line-by-line and updates convertState.CurrentFilePct in real time.
// The stream emits `key=value` lines, terminated by
// `progress=continue` (each tick) or `progress=end` (finished).
//
// We close `done` when the reader returns so cmd.Wait() can safely
// proceed without a race against the goroutine.
func streamConvertProgress(r io.Reader, duration float64, done chan struct{}) {
	defer close(done)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		// `out_time=HH:MM:SS.mmm` is the unambiguous one — works
		// across all ffmpeg versions we care about (4+).
		if !strings.HasPrefix(line, "out_time=") {
			continue
		}
		secStr := strings.TrimPrefix(line, "out_time=")
		secs, ok := parseFFmpegTime(secStr)
		if !ok {
			continue
		}
		pct := 0.0
		if duration > 0 {
			pct = math.Min(100, (secs/duration)*100)
		}
		convertMu.Lock()
		convertState.CurrentFileSec = secs
		convertState.CurrentFilePct = pct
		convertMu.Unlock()
	}
}

// parseFFmpegTime parses a "HH:MM:SS.uuuuuu" time string from
// ffmpeg's -progress output into seconds. Returns (0, false) for
// "N/A" or malformed input.
func parseFFmpegTime(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "N/A" {
		return 0, false
	}
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return 0, false
	}
	h, err1 := strconv.ParseFloat(parts[0], 64)
	m, err2 := strconv.ParseFloat(parts[1], 64)
	sec, err3 := strconv.ParseFloat(parts[2], 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, false
	}
	return h*3600 + m*60 + sec, true
}

// humanBytes formats n into a short SI-ish string ("4.3 GB", "789 MB").
// Used in error messages so the user sees real numbers instead of
// raw byte counts.
func humanBytes(n uint64) string {
	if n == 0 {
		return "0 B"
	}
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	v := float64(n)
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	// 1 decimal under 10, integer above (so "4.3 GB" but "256 GB").
	if v < 10 {
		return fmt.Sprintf("%.1f %s", v, units[i])
	}
	return fmt.Sprintf("%.0f %s", math.Round(v), units[i])
}
