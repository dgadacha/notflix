package core

import (
	"path/filepath"

	"notflix/internal/database/db"
	"notflix/internal/tmdb"
	"notflix/internal/torbox"
)

// App is the singleton wiring container. Handlers get a *App so they can
// reach everything without passing 5+ args around.
type App struct {
	Config   *Config
	Database *db.Database
	TMDB     *tmdb.Client
	TorBox   *torbox.Client
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
	}
	return app, nil
}

func (a *App) Close() {
	if a.Database != nil {
		_ = a.Database.Close()
	}
}
