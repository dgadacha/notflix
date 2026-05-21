package handlers

import (
	"crypto/sha256"
	"encoding/hex"
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

// In-process cache. Keyed by sha256(text|target). Loses contents on restart.
type translateCacheEntry struct {
	value    string
	expires  time.Time
}

var (
	translateCache   = make(map[string]translateCacheEntry)
	translateCacheMu sync.RWMutex
	translateClient  = &http.Client{Timeout: 15 * time.Second}
)

const translateCacheTTL = 30 * 24 * time.Hour

func translateCacheKey(text, target string) string {
	h := sha256.Sum256([]byte(text + "|" + target))
	return hex.EncodeToString(h[:])
}

// HandleTranslateText
//
//	@summary proxies translation requests to DeepL Free / Pro.
//	@desc Accepts either {text, target, key} for a single string or
//	      {texts, target, key} for a batch (DeepL allows up to 50 per
//	      request, much friendlier on the monthly quota when an anime
//	      has 25+ episodes). Cache is per-string and 30 days, so the
//	      second visit is free.
//	@route /api/v1/translate [POST]
//	@returns {translated string} or {translated []string} depending on input
func (h *Handler) HandleTranslateText(c echo.Context) error {
	type body struct {
		Text   string   `json:"text"`
		Texts  []string `json:"texts"`
		Target string   `json:"target"`
		Key    string   `json:"key"`
	}

	var b body
	if err := c.Bind(&b); err != nil {
		return h.RespondWithError(c, fmt.Errorf("invalid body: %w", err))
	}
	b.Target = strings.ToUpper(strings.TrimSpace(b.Target))
	b.Key = strings.TrimSpace(b.Key)
	if b.Target == "" {
		return h.RespondWithError(c, fmt.Errorf("missing target language"))
	}
	if b.Key == "" {
		return h.RespondWithError(c, fmt.Errorf("missing DeepL API key"))
	}

	batched := len(b.Texts) > 0
	inputs := b.Texts
	if !batched {
		inputs = []string{b.Text}
	}

	// Trim, separate cached vs uncached.
	out := make([]string, len(inputs))
	missingIdx := make([]int, 0, len(inputs))
	missingTexts := make([]string, 0, len(inputs))
	for i, raw := range inputs {
		s := strings.TrimSpace(raw)
		if s == "" {
			out[i] = ""
			continue
		}
		key := translateCacheKey(s, b.Target)
		translateCacheMu.RLock()
		entry, ok := translateCache[key]
		translateCacheMu.RUnlock()
		if ok && time.Now().Before(entry.expires) {
			out[i] = entry.value
			continue
		}
		missingIdx = append(missingIdx, i)
		missingTexts = append(missingTexts, s)
	}

	// Hit DeepL only if anything is missing.
	if len(missingTexts) > 0 {
		host := "api.deepl.com"
		if strings.HasSuffix(b.Key, ":fx") {
			host = "api-free.deepl.com"
		}

		form := url.Values{}
		for _, t := range missingTexts {
			form.Add("text", t)
		}
		form.Set("target_lang", b.Target)
		form.Set("preserve_formatting", "1")

		req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost,
			"https://"+host+"/v2/translate", strings.NewReader(form.Encode()))
		if err != nil {
			return h.RespondWithError(c, err)
		}
		req.Header.Set("Authorization", "DeepL-Auth-Key "+b.Key)
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("User-Agent", "notflix/1.0")

		resp, err := translateClient.Do(req)
		if err != nil {
			return h.RespondWithError(c, err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			return h.RespondWithError(c, fmt.Errorf("deepl returned %d: %s", resp.StatusCode, string(body)))
		}

		var parsed struct {
			Translations []struct {
				Text string `json:"text"`
			} `json:"translations"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			return h.RespondWithError(c, err)
		}

		if len(parsed.Translations) != len(missingTexts) {
			return h.RespondWithError(c, fmt.Errorf("deepl returned %d translations for %d inputs",
				len(parsed.Translations), len(missingTexts)))
		}

		translateCacheMu.Lock()
		for j, tr := range parsed.Translations {
			pos := missingIdx[j]
			out[pos] = tr.Text
			translateCache[translateCacheKey(missingTexts[j], b.Target)] = translateCacheEntry{
				value:   tr.Text,
				expires: time.Now().Add(translateCacheTTL),
			}
		}
		translateCacheMu.Unlock()
	}

	if batched {
		return h.RespondWithData(c, map[string][]string{"translated": out})
	}
	return h.RespondWithData(c, map[string]string{"translated": out[0]})
}
