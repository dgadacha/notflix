package core

import (
	"log"
	"path/filepath"

	"notflix/internal/database/db"
	"notflix/internal/database/models"
	"notflix/internal/prowlarr"
	"notflix/internal/tmdb"
	"notflix/internal/torbox"

	"golang.org/x/crypto/bcrypt"
)

// App is the singleton wiring container. Handlers get a *App so they can
// reach everything without passing 5+ args around.
type App struct {
	Config   *Config
	Database *db.Database
	TMDB     *tmdb.Client
	TorBox   *torbox.Client
	Prowlarr *prowlarr.Client
}

// Setting keys used by the admin UI to override env-var defaults.
// They live in the `settings` table; the env vars are still read at
// boot so a fresh install works without touching the DB.
const (
	SettingTMDBAPIKey     = "tmdb_api_key"
	SettingTorBoxAPIKey   = "torbox_api_key"
	SettingProwlarrURL    = "prowlarr_url"
	SettingProwlarrAPIKey = "prowlarr_api_key"
)

func New() (*App, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}

	database, err := db.Open(filepath.Join(cfg.Data.Dir, "notflix.db"))
	if err != nil {
		return nil, err
	}

	// Overlay any admin-written settings on top of the env-var defaults.
	// DB wins when present so the UI is the canonical place to manage
	// keys after first boot.
	overlaySettingsOnto(database, cfg)

	app := &App{
		Config:   cfg,
		Database: database,
		TMDB:     tmdb.NewClient(cfg.TMDB.APIKey),
		TorBox:   torbox.NewClient(cfg.TorBox.APIKey),
		Prowlarr: prowlarr.NewClient(cfg.Prowlarr.BaseURL, cfg.Prowlarr.APIKey),
	}

	// Bootstrap the admin user on first boot. If the table is empty,
	// create one with the env-var credentials (defaulting to admin /
	// admin so a fresh install lets the user in immediately — the
	// README warns to change it).
	if err := app.bootstrapAdmin(); err != nil {
		return nil, err
	}

	return app, nil
}

// overlaySettingsOnto reads the four admin-mutable keys from the DB and
// patches them into the Config struct. Empty / missing rows leave the
// env-var value untouched. Silent on DB errors — if the settings table
// is unreadable the env values are still a working fallback.
func overlaySettingsOnto(database *db.Database, cfg *Config) {
	rows, err := database.GetSettings([]string{
		SettingTMDBAPIKey,
		SettingTorBoxAPIKey,
		SettingProwlarrURL,
		SettingProwlarrAPIKey,
	})
	if err != nil {
		return
	}
	if v := rows[SettingTMDBAPIKey]; v != "" {
		cfg.TMDB.APIKey = v
	}
	if v := rows[SettingTorBoxAPIKey]; v != "" {
		cfg.TorBox.APIKey = v
	}
	if v := rows[SettingProwlarrURL]; v != "" {
		cfg.Prowlarr.BaseURL = v
	}
	if v := rows[SettingProwlarrAPIKey]; v != "" {
		cfg.Prowlarr.APIKey = v
	}
}

// ApplyServerConfig writes the four admin-mutable keys to the settings
// table, updates the in-memory Config, and hot-swaps the credentials
// inside each client. Empty strings clear the corresponding setting so
// the next boot falls back to the env-var (or, if no env-var, an
// unconfigured client that the /status endpoint flags as missing).
//
// Caller must hold the admin role check — the App layer doesn't
// re-check, it trusts handlers/auth.go's RequireAdmin.
func (a *App) ApplyServerConfig(tmdbKey, torboxKey, prowlarrURL, prowlarrKey string) error {
	pairs := []struct {
		key, val string
	}{
		{SettingTMDBAPIKey, tmdbKey},
		{SettingTorBoxAPIKey, torboxKey},
		{SettingProwlarrURL, prowlarrURL},
		{SettingProwlarrAPIKey, prowlarrKey},
	}
	for _, p := range pairs {
		if err := a.Database.SetSetting(p.key, p.val); err != nil {
			return err
		}
	}
	a.Config.TMDB.APIKey = tmdbKey
	a.Config.TorBox.APIKey = torboxKey
	a.Config.Prowlarr.BaseURL = prowlarrURL
	a.Config.Prowlarr.APIKey = prowlarrKey
	a.TMDB.SetAPIKey(tmdbKey)
	a.TorBox.SetAPIKey(torboxKey)
	a.Prowlarr.SetConfig(prowlarrURL, prowlarrKey)
	return nil
}

func (a *App) bootstrapAdmin() error {
	count, err := a.Database.CountUsers()
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(a.Config.Auth.AdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	admin := &models.User{
		Username:     a.Config.Auth.AdminUsername,
		PasswordHash: string(hash),
		IsAdmin:      true,
		DisplayName:  a.Config.Auth.AdminUsername,
	}
	if _, err := a.Database.CreateUser(admin); err != nil {
		return err
	}
	log.Printf("auth: bootstrapped admin user %q (change the password from the admin UI)", admin.Username)
	return nil
}

func (a *App) Close() {
	if a.Database != nil {
		_ = a.Database.Close()
	}
}
