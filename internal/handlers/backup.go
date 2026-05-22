package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"notflix/internal/core"
	"notflix/internal/database/models"

	"github.com/labstack/echo/v4"
)

// Backup / restore — admin-only.
//
// Exports the user's whole world (profiles, history, "My List", server
// keys) into one JSON blob the admin can save off-host as a personal
// backup or migrate to another Notflix install. Restore can replay the
// JSON back into a fresh install.
//
// Format version 1 — bumped only when the shape changes in a way that
// older restores can't read. New OPTIONAL fields are added without a
// bump.

const backupSchemaVersion = 1

// HandleBackupExport — GET /api/v1/admin/backup
//
// Returns a JSON file the browser downloads as
// `notflix-backup-<ISO date>.json`. Admin-gated upstream.
//
// Secrets policy: server config keys (TMDB / TorBox / Prowlarr /
// Anthropic) ARE included so the backup is genuinely portable. If the
// user shares the file with someone, they share the keys — same risk
// as sharing the binary's config.toml.
func (h *Handler) HandleBackupExport(c echo.Context) error {
	bundle, err := h.buildBackup()
	if err != nil {
		log.Printf("backup export: build failed: %v", err)
		return c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
	}

	body, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]any{"error": "marshal: " + err.Error()})
	}

	filename := fmt.Sprintf("notflix-backup-%s.json", time.Now().UTC().Format("2006-01-02"))
	c.Response().Header().Set("Content-Type", "application/json")
	c.Response().Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	return c.Blob(http.StatusOK, "application/json", body)
}

// HandleBackupRestore — POST /api/v1/admin/backup/restore
//
// Accepts the same JSON shape Export produces. Applies it on top of
// the live DB:
//   - Profiles: upserted by uid. Name/avatar/color overwritten.
//   - History rows: upserted by (profile_uid, media_id) so duplicates
//     don't accumulate.
//   - List entries: upserted by (profile_uid, tmdb_id, media_type).
//   - Server config: optional, gated by a `?config=1` query param so
//     restoring history alone never silently rotates keys.
//
// Returns counts of each kind so the user gets feedback in the UI.
func (h *Handler) HandleBackupRestore(c echo.Context) error {
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, 32<<20)) // 32 MB cap
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "read: " + err.Error()})
	}
	defer c.Request().Body.Close()

	var bundle backupBundle
	if err := json.Unmarshal(body, &bundle); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid json: " + err.Error()})
	}
	if bundle.Version == 0 || bundle.Version > backupSchemaVersion {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("unsupported backup version %d", bundle.Version),
		})
	}

	restoreConfig := c.QueryParam("config") == "1"

	stats := struct {
		Profiles   int `json:"profiles"`
		History    int `json:"history"`
		ListItems  int `json:"listItems"`
		ConfigKeys int `json:"configKeys"`
	}{}

	for _, p := range bundle.Profiles {
		if p.UID == "" || p.Name == "" {
			continue
		}
		_, err := h.upsertProfile(p)
		if err != nil {
			log.Printf("backup restore: profile %q: %v", p.UID, err)
			continue
		}
		stats.Profiles++

		for _, h2 := range p.History {
			h2.ProfileUID = p.UID // safety net
			if _, err := h.App.Database.UpsertWatchHistory(toHistoryModel(h2)); err != nil {
				log.Printf("backup restore: history %d: %v", h2.TMDBID, err)
				continue
			}
			stats.History++
		}

		for _, e := range p.List {
			e.ProfileUID = p.UID
			if _, err := h.App.Database.UpsertProfileList(toListModel(e)); err != nil {
				log.Printf("backup restore: list %d: %v", e.TMDBID, err)
				continue
			}
			stats.ListItems++
		}
	}

	if restoreConfig && bundle.Config != nil {
		if err := h.App.ApplyServerConfig(
			bundle.Config.TMDBAPIKey,
			bundle.Config.TorBoxAPIKey,
			bundle.Config.ProwlarrURL,
			bundle.Config.ProwlarrAPIKey,
			bundle.Config.AnthropicAPIKey,
			bundle.Config.AnthropicModel,
		); err != nil {
			log.Printf("backup restore: config: %v", err)
		} else {
			stats.ConfigKeys = 6
		}
	}

	return RespondOK(c, stats)
}

// -----------------------------------------------------------------------------
// Bundle shape
// -----------------------------------------------------------------------------

type backupBundle struct {
	Version    int               `json:"version"`
	ExportedAt string            `json:"exportedAt"`
	Notflix    string            `json:"notflix"` // marketing-shaped marker so a glance at the file says what it is
	Config     *backupConfig     `json:"config,omitempty"`
	Profiles   []backupProfile   `json:"profiles"`
}

type backupConfig struct {
	TMDBAPIKey      string `json:"tmdbApiKey"`
	TorBoxAPIKey    string `json:"torboxApiKey"`
	ProwlarrURL     string `json:"prowlarrUrl"`
	ProwlarrAPIKey  string `json:"prowlarrApiKey"`
	AnthropicAPIKey string `json:"anthropicApiKey"`
	AnthropicModel  string `json:"anthropicModel"`
}

type backupProfile struct {
	UID       string          `json:"uid"`
	Name      string          `json:"name"`
	Avatar    string          `json:"avatar"`
	Color     string          `json:"color"`
	CreatedAt string          `json:"createdAt,omitempty"`
	History   []backupHistory `json:"history,omitempty"`
	List      []backupListItem `json:"list,omitempty"`
}

type backupHistory struct {
	ProfileUID      string  `json:"profileUid"`
	TMDBID          int     `json:"tmdbId"`
	MediaType       string  `json:"mediaType"`
	Season          int     `json:"season"`
	Episode         int     `json:"episode"`
	CurrentTime     float64 `json:"currentTime"`
	Duration        float64 `json:"duration"`
	Title           string  `json:"title"`
	PosterPath      string  `json:"posterPath"`
	BackdropURL     string  `json:"backdropUrl"`
	ReleaseName     string  `json:"releaseName,omitempty"`
	ReleaseSource   string  `json:"releaseSource,omitempty"`
	ReleaseInfoHash string  `json:"releaseInfoHash,omitempty"`
	UpdatedAt       string  `json:"updatedAt,omitempty"`
}

type backupListItem struct {
	ProfileUID string `json:"profileUid"`
	TMDBID     int    `json:"tmdbId"`
	MediaType  string `json:"mediaType"`
	Status     string `json:"status"`
	Title      string `json:"title"`
	PosterPath string `json:"posterPath"`
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

func (h *Handler) buildBackup() (*backupBundle, error) {
	profiles, err := h.App.Database.ListProfiles()
	if err != nil {
		return nil, fmt.Errorf("list profiles: %w", err)
	}

	out := &backupBundle{
		Version:    backupSchemaVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Notflix:    "notflix-backup",
		Config: &backupConfig{
			TMDBAPIKey:      h.App.Config.TMDB.APIKey,
			TorBoxAPIKey:    h.App.Config.TorBox.APIKey,
			ProwlarrURL:     h.App.Config.Prowlarr.BaseURL,
			ProwlarrAPIKey:  h.App.Config.Prowlarr.APIKey,
			AnthropicAPIKey: h.App.Config.Anthropic.APIKey,
			AnthropicModel:  h.App.Config.Anthropic.Model,
		},
		Profiles: make([]backupProfile, 0, len(profiles)),
	}

	for _, p := range profiles {
		bp := backupProfile{
			UID:       p.UID,
			Name:      p.Name,
			Avatar:    p.Avatar,
			Color:     p.Color,
			CreatedAt: p.CreatedAt.Format(time.RFC3339),
		}
		// Watch history.
		hist, err := h.App.Database.ListWatchHistory(p.UID)
		if err == nil {
			for _, e := range hist {
				bp.History = append(bp.History, backupHistory{
					ProfileUID:      e.ProfileUID,
					TMDBID:          e.TMDBID,
					MediaType:       e.MediaType,
					Season:          e.Season,
					Episode:         e.Episode,
					CurrentTime:     e.CurrentTime,
					Duration:        e.Duration,
					Title:           e.Title,
					PosterPath:      e.PosterPath,
					BackdropURL:     e.BackdropURL,
					ReleaseName:     e.ReleaseName,
					ReleaseSource:   e.ReleaseSource,
					ReleaseInfoHash: e.ReleaseInfoHash,
					UpdatedAt:       e.UpdatedAt.Format(time.RFC3339),
				})
			}
		}
		// My List.
		list, err := h.App.Database.ListProfileList(p.UID)
		if err == nil {
			for _, e := range list {
				bp.List = append(bp.List, backupListItem{
					ProfileUID: e.ProfileUID,
					TMDBID:     e.TMDBID,
					MediaType:  e.MediaType,
					Status:     e.Status,
					Title:      e.Title,
					PosterPath: e.PosterPath,
				})
			}
		}
		out.Profiles = append(out.Profiles, bp)
	}
	return out, nil
}

// upsertProfile creates or updates a profile by UID. Designed to merge
// gracefully with a profile that already exists (eg. partial restore).
func (h *Handler) upsertProfile(p backupProfile) (*models.Profile, error) {
	existing, err := h.App.Database.GetProfile(p.UID)
	if err == nil && existing != nil {
		return h.App.Database.UpdateProfile(p.UID, p.Name, p.Avatar, p.Color)
	}
	return h.App.Database.CreateProfile(&models.Profile{
		UID:    p.UID,
		Name:   p.Name,
		Avatar: p.Avatar,
		Color:  p.Color,
	})
}

func toHistoryModel(h backupHistory) *models.ProfileWatchHistory {
	return &models.ProfileWatchHistory{
		ProfileUID:      h.ProfileUID,
		TMDBID:          h.TMDBID,
		MediaType:       h.MediaType,
		Season:          h.Season,
		Episode:         h.Episode,
		CurrentTime:     h.CurrentTime,
		Duration:        h.Duration,
		Title:           h.Title,
		PosterPath:      h.PosterPath,
		BackdropURL:     h.BackdropURL,
		ReleaseName:     h.ReleaseName,
		ReleaseSource:   h.ReleaseSource,
		ReleaseInfoHash: h.ReleaseInfoHash,
	}
}

func toListModel(e backupListItem) *models.ProfileListEntry {
	return &models.ProfileListEntry{
		ProfileUID: e.ProfileUID,
		TMDBID:     e.TMDBID,
		MediaType:  e.MediaType,
		Status:     e.Status,
		Title:      e.Title,
		PosterPath: e.PosterPath,
	}
}

// Quiet a potential unused-import lint when the `core` package only
// shows up via h.App.Config.TMDB etc., which the compiler resolves
// through the App struct indirectly.
var _ = core.SettingTMDBAPIKey
