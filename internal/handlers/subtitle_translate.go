// Subtitle translation via Claude.
//
// The HLS /sub_<idx>.vtt endpoint accepts an optional `translateTo`
// query param. When present (and the Anthropic key is configured) the
// VTT bytes from ffmpeg are run through Claude to produce a translation
// in the requested language, cached on disk, and served.
//
// Caching keys on (sessionId, subtitle idx, target lang). Sessions
// embed a hash of the source URL so the cache is naturally per-file.
package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"notflix/internal/anthropic"
)

const (
	// Cues per Claude call. Trade-off: bigger batches = fewer round
	// trips but higher risk of the model dropping / merging lines
	// when responding. 25 keeps each request well under 1 KB while
	// staying close to "one shot per minute of dialogue".
	translateBatchSize = 25
)

// langName returns a human-readable target language name for the
// translation prompt. We send the full English name (Claude is more
// reliable with these than with BCP-47 codes).
func translateLangName(code string) string {
	switch strings.ToLower(code) {
	case "fr", "fre", "fra":
		return "French"
	case "en", "eng":
		return "English"
	case "es", "spa":
		return "Spanish"
	case "de", "ger", "deu":
		return "German"
	case "it", "ita":
		return "Italian"
	case "pt", "por":
		return "Portuguese"
	case "ja", "jpn":
		return "Japanese"
	case "zh", "chi", "zho":
		return "Chinese"
	case "ko", "kor":
		return "Korean"
	case "ru", "rus":
		return "Russian"
	case "ar", "ara":
		return "Arabic"
	case "nl", "nld", "dut":
		return "Dutch"
	}
	return code
}

// translateSubtitleCache hashes (sessionId, idx, targetLang) into a
// cache path under <datadir>/cache/subtitles/. Sessions already encode
// the source URL into their id, so two distinct files always land in
// distinct cache files.
func (h *Handler) translateSubtitleCachePath(sessionID string, idx int, targetLang string) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%s", sessionID, idx, strings.ToLower(targetLang))))
	name := hex.EncodeToString(digest[:12]) + ".vtt"
	return filepath.Join(h.App.Config.Data.Dir, "cache", "subtitles", name)
}

// translateVTT is a thin shim over translateVTTWithProgress that
// discards the per-batch progress callback. Used by callers that
// don't surface progress (e.g. the on-demand serveHLSSubtitle path).
func translateVTT(ctx context.Context, client *anthropic.Client, vtt []byte, targetLang string) ([]byte, error) {
	return translateVTTWithProgress(ctx, client, vtt, targetLang, nil)
}

// translateVTTWithProgress is the full version — exposes a per-batch
// progress callback so the watch-page polling endpoint can render a
// percentage. `cb(done, total)` is called after every Claude round-trip
// (success or fall-back). Caller is free to pass nil to skip progress.
func translateVTTWithProgress(ctx context.Context, client *anthropic.Client, vtt []byte, targetLang string, cb func(done, total int)) ([]byte, error) {
	lines := strings.Split(string(vtt), "\n")
	// Identify which lines are TEXT (dialogue) vs structure. A line is
	// text iff it's not a header, not a timing line (contains " --> "),
	// not a cue number (digits only), and not blank.
	type textLine struct {
		idx  int
		orig string
	}
	var texts []textLine
	for i, l := range lines {
		t := strings.TrimRight(l, "\r")
		if t == "" {
			continue
		}
		if t == "WEBVTT" || strings.HasPrefix(t, "WEBVTT ") {
			continue
		}
		if strings.HasPrefix(t, "NOTE") || strings.HasPrefix(t, "STYLE") {
			continue
		}
		if strings.Contains(t, " --> ") {
			continue
		}
		// Pure digits → cue number.
		if isAllDigits(t) {
			continue
		}
		texts = append(texts, textLine{idx: i, orig: t})
	}
	if len(texts) == 0 {
		return vtt, nil
	}

	target := translateLangName(targetLang)

	// Translate in batches. Each batch sends ~25 lines, gets the same
	// number back in the same order. If the response doesn't match the
	// expected line count we fall back to original text for that batch.
	out := make([]string, len(lines))
	copy(out, lines)

	totalBatches := (len(texts) + translateBatchSize - 1) / translateBatchSize
	doneBatches := 0
	for start := 0; start < len(texts); start += translateBatchSize {
		end := start + translateBatchSize
		if end > len(texts) {
			end = len(texts)
		}
		batch := texts[start:end]

		var prompt strings.Builder
		prompt.WriteString("Translate each numbered line to ")
		prompt.WriteString(target)
		prompt.WriteString(". Output exactly the same number of lines, ")
		prompt.WriteString("keeping the [N] prefix, no extra commentary. ")
		prompt.WriteString("Preserve speaker tags like \"♪\", \"-\", \"<i>\", ")
		prompt.WriteString("\"</i>\" as in the original.\n\n")
		for i, b := range batch {
			fmt.Fprintf(&prompt, "[%d] %s\n", i+1, b.orig)
		}

		resp, err := client.SendMessage(ctx, anthropic.MessagesRequest{
			MaxTokens:   2048,
			Temperature: 0,
			System:      "You translate subtitle lines literally and concisely. Never add or omit lines. Each output line MUST start with the same [N] marker as the input.",
			Messages: []anthropic.Message{
				{Role: "user", Content: prompt.String()},
			},
		})
		if err != nil {
			log.Printf("subtitle translate: batch %d-%d failed: %v", start, end, err)
			doneBatches++
			if cb != nil {
				cb(doneBatches, totalBatches)
			}
			continue // fall back to original
		}

		translated := parseTranslatedBatch(resp, len(batch))
		if translated == nil {
			log.Printf("subtitle translate: batch %d-%d: response shape unexpected", start, end)
			doneBatches++
			if cb != nil {
				cb(doneBatches, totalBatches)
			}
			continue
		}
		for i, t := range translated {
			out[batch[i].idx] = t
		}
		doneBatches++
		if cb != nil {
			cb(doneBatches, totalBatches)
		}
	}

	return []byte(strings.Join(out, "\n")), nil
}

// parseTranslatedBatch extracts the N lines from a Claude response that
// look like "[1] foo", "[2] bar", … Returns nil when the count or
// markers don't match what we asked for — caller falls back to original.
func parseTranslatedBatch(resp string, expected int) []string {
	lines := strings.Split(strings.TrimSpace(resp), "\n")
	out := make([]string, 0, expected)
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		// Expected shape: "[N] translated text"
		open := strings.IndexByte(l, '[')
		close := strings.IndexByte(l, ']')
		if open != 0 || close <= 1 {
			continue
		}
		text := strings.TrimSpace(l[close+1:])
		out = append(out, text)
	}
	if len(out) != expected {
		return nil
	}
	return out
}

// readCachedTranslation returns the cached VTT for (sessionId, idx, lang)
// if present, else nil. Errors are treated as "no cache" — caller will
// regenerate.
func (h *Handler) readCachedTranslation(sessionID string, idx int, lang string) []byte {
	p := h.translateSubtitleCachePath(sessionID, idx, lang)
	b, err := os.ReadFile(p)
	if err != nil || len(b) == 0 {
		return nil
	}
	return b
}

// hasCachedTranslation cheaply checks whether the cache file exists,
// without reading or returning the bytes. Used by the pre-warm path
// to skip tracks that are already extracted.
func (h *Handler) hasCachedTranslation(sessionID string, idx int, lang string) bool {
	p := h.translateSubtitleCachePath(sessionID, idx, lang)
	info, err := os.Stat(p)
	return err == nil && info.Size() > 0
}

// writeCachedTranslation persists the translated VTT to disk. Best
// effort — cache misses on subsequent fetches just regenerate.
func (h *Handler) writeCachedTranslation(sessionID string, idx int, lang string, vtt []byte) {
	p := h.translateSubtitleCachePath(sessionID, idx, lang)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, vtt, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, p)
}

func isAllDigits(s string) bool {
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
