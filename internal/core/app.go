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

func New() (*App, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, err
	}

	database, err := db.Open(filepath.Join(cfg.Data.Dir, "notflix.db"))
	if err != nil {
		return nil, err
	}

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
