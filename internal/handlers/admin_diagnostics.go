package handlers

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"notflix/internal/anthropic"

	"github.com/labstack/echo/v4"
)

// HandleTestProvider — POST /api/v1/admin/test/:provider
//
// Quick live ping of one configured backend. Returns {ok, info, error}
// so the settings UI can show ✓ green / ✗ red without the user
// guessing whether a key is actually accepted.
//
// Providers:
//   - tmdb       → GET /configuration (cheap, always works if key valid)
//   - torbox     → /user/me via Ping()
//   - prowlarr   → /api/v1/system/status via SystemStatus()
//   - anthropic  → 4-token completion ("Reply OK")
//
// All providers test the CURRENTLY-CONFIGURED key, not a key passed in
// the body. That keeps the contract simple — the user saves, then
// tests. The roundtrip is fast enough (1-3 s) that this isn't a real
// friction point.
//
// Admin-gated upstream by the /admin group's RequireAdmin middleware.
func (h *Handler) HandleTestProvider(c echo.Context) error {
	provider := c.Param("provider")
	ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
	defer cancel()

	switch provider {
	case "tmdb":
		if !h.App.TMDB.HasKey() {
			return testResult(c, false, "", "not configured")
		}
		_, err := h.App.TMDB.Get(ctx, "/configuration", nil)
		if err != nil {
			return testResult(c, false, "", err.Error())
		}
		return testResult(c, true, "OK", "")

	case "torbox":
		if !h.App.TorBox.HasKey() {
			return testResult(c, false, "", "not configured")
		}
		u, err := h.App.TorBox.Ping(ctx)
		if err != nil {
			return testResult(c, false, "", err.Error())
		}
		info := torboxPlanName(u.Plan)
		if u.Email != "" {
			if info != "" {
				info = fmt.Sprintf("%s · %s", info, u.Email)
			} else {
				info = u.Email
			}
		}
		return testResult(c, true, info, "")

	case "prowlarr":
		if !h.App.Prowlarr.Configured() {
			return testResult(c, false, "", "not configured")
		}
		s, err := h.App.Prowlarr.SystemStatus(ctx)
		if err != nil {
			return testResult(c, false, "", err.Error())
		}
		return testResult(c, true, fmt.Sprintf("%s v%s", s.AppName, s.Version), "")

	case "anthropic":
		if !h.App.Anthropic.HasKey() {
			return testResult(c, false, "", "not configured")
		}
		// Tiny completion — bounded cost (<$0.0001), no real prompt.
		// Anthropic billing is per-token; 4 max tokens caps the
		// damage even if the model decides to reply verbosely.
		_, err := h.App.Anthropic.SendMessage(ctx, anthropic.MessagesRequest{
			MaxTokens: 4,
			Messages:  []anthropic.Message{{Role: "user", Content: "Reply with just the word OK."}},
		})
		if err != nil {
			return testResult(c, false, "", err.Error())
		}
		return testResult(c, true, "OK", "")
	}
	return c.JSON(http.StatusBadRequest, map[string]any{"error": "unknown provider: " + provider})
}

func testResult(c echo.Context, ok bool, info, errMsg string) error {
	return RespondOK(c, map[string]any{
		"ok":    ok,
		"info":  info,
		"error": errMsg,
	})
}
