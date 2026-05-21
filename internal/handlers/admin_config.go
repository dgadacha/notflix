// Package handlers — admin-only endpoints exposing the four
// hot-swappable server credentials (TMDB / TorBox / Prowlarr URL +
// key) so an admin can rotate them from the settings UI without
// shelling into the container to edit `.env`.
//
// Read side returns metadata only (lengths, masked tails, "isSet"
// booleans) — never the full secret. Write side accepts the full
// values and persists them to the `settings` table, then re-hydrates
// the in-memory Config + hot-swaps the credential inside each client.
//
// Gated by RequireAdmin in routes.go: child accounts get 403.
package handlers

import (
	"net/http"
	"strings"

	"notflix/internal/core"

	"github.com/labstack/echo/v4"
)

// configFieldStatus is what the GET endpoint returns for each key —
// just enough for the UI to render "✓ configuré · ****abcd" without
// leaking the full secret to the browser DevTools network panel.
type configFieldStatus struct {
	IsSet  bool   `json:"isSet"`
	Masked string `json:"masked"`
	// Source: "env" when the value still comes from a NOTFLIX_* env var
	// (the DB has nothing), "db" when the admin has saved an override
	// from the UI. Lets the UI hint "reading from env — save here to
	// override".
	Source string `json:"source"`
}

// HandleGetServerConfig returns the masked status of each admin-mutable
// credential. URL + non-secret model fields are returned verbatim.
func (h *Handler) HandleGetServerConfig(c echo.Context) error {
	dbVals, err := h.App.Database.GetSettings([]string{
		core.SettingTMDBAPIKey,
		core.SettingTorBoxAPIKey,
		core.SettingProwlarrURL,
		core.SettingProwlarrAPIKey,
		core.SettingAnthropicAPIKey,
		core.SettingAnthropicModel,
	})
	if err != nil {
		return RespondErr(c, err)
	}

	return RespondOK(c, map[string]any{
		"tmdbApiKey":      mask(h.App.Config.TMDB.APIKey, dbVals[core.SettingTMDBAPIKey]),
		"torboxApiKey":    mask(h.App.Config.TorBox.APIKey, dbVals[core.SettingTorBoxAPIKey]),
		"prowlarrApiKey":  mask(h.App.Config.Prowlarr.APIKey, dbVals[core.SettingProwlarrAPIKey]),
		"anthropicApiKey": mask(h.App.Config.Anthropic.APIKey, dbVals[core.SettingAnthropicAPIKey]),
		// URL + model: not secrets, returned verbatim with the source pill.
		"prowlarrUrl": map[string]any{
			"value":  h.App.Config.Prowlarr.BaseURL,
			"isSet":  h.App.Config.Prowlarr.BaseURL != "",
			"source": sourceOf(dbVals[core.SettingProwlarrURL]),
		},
		"anthropicModel": map[string]any{
			"value":  h.App.Config.Anthropic.Model,
			"isSet":  h.App.Config.Anthropic.Model != "",
			"source": sourceOf(dbVals[core.SettingAnthropicModel]),
		},
	})
}

// HandleUpdateServerConfig accepts a partial body (any subset of the
// six keys), persists the non-nil values, and hot-applies them. Nil
// or absent keys leave the current value untouched; an empty string
// explicitly clears the override (next boot falls back to env, or
// becomes unset if no env value).
func (h *Handler) HandleUpdateServerConfig(c echo.Context) error {
	var body struct {
		TMDBAPIKey      *string `json:"tmdbApiKey"`
		TorBoxAPIKey    *string `json:"torboxApiKey"`
		ProwlarrURL     *string `json:"prowlarrUrl"`
		ProwlarrAPIKey  *string `json:"prowlarrApiKey"`
		AnthropicAPIKey *string `json:"anthropicApiKey"`
		AnthropicModel  *string `json:"anthropicModel"`
	}
	if err := c.Bind(&body); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
	}

	// Resolve each field: explicit string from body → use it (even ""),
	// nil/absent → keep current.
	tmdb := pickString(body.TMDBAPIKey, h.App.Config.TMDB.APIKey)
	torbox := pickString(body.TorBoxAPIKey, h.App.Config.TorBox.APIKey)
	prowURL := pickString(body.ProwlarrURL, h.App.Config.Prowlarr.BaseURL)
	prowKey := pickString(body.ProwlarrAPIKey, h.App.Config.Prowlarr.APIKey)
	anthropicKey := pickString(body.AnthropicAPIKey, h.App.Config.Anthropic.APIKey)
	anthropicModel := pickString(body.AnthropicModel, h.App.Config.Anthropic.Model)

	if err := h.App.ApplyServerConfig(tmdb, torbox, prowURL, prowKey, anthropicKey, anthropicModel); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

func mask(currentVal, dbVal string) map[string]any {
	return map[string]any{
		"isSet":  currentVal != "",
		"masked": maskedTail(currentVal),
		"source": sourceOf(dbVal),
	}
}

// maskedTail shows the last 4 chars of a secret with a short stub of
// asterisks in front. Anthropic API keys are ~108 chars long; with the
// full-length mask the resulting "***…***abcd" string overflowed the
// settings card. Cap the stub at 8 asterisks — the masked output is
// purely cosmetic (lets the admin glance at the key tail), no need to
// echo back the full length.
func maskedTail(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 6 {
		return strings.Repeat("*", len(s))
	}
	return "********" + s[len(s)-4:]
}

// sourceOf reports where a credential is currently coming from. If the
// DB has a non-empty override, the effective value is "db"; otherwise
// it's still the env-var default ("env").
func sourceOf(dbValue string) string {
	if dbValue != "" {
		return "db"
	}
	return "env"
}

func pickString(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}
