package core

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
)

// Config — the runtime config loaded once at startup. Mirrors Kuro's shape
// to keep the deploy story identical: one toml file under the datadir, env
// vars + flags override.
type Config struct {
	Server struct {
		Host string
		Port int
	}
	TMDB struct {
		// API key — get one for free at https://www.themoviedb.org/settings/api
		APIKey string
	}
	TorBox struct {
		// API key — copy from https://torbox.app/settings
		APIKey string
	}
	Prowlarr struct {
		// Base URL of a Prowlarr instance (e.g. http://127.0.0.1:9696).
		BaseURL string
		// X-Api-Key value from Prowlarr's General settings.
		APIKey string
	}
	Auth struct {
		// Bootstrap credentials for the admin user. Only used on first
		// boot — once the user exists in the DB the env vars are ignored.
		// Defaults to admin/admin so a fresh install isn't blocked, but
		// the README warns users to override these.
		AdminUsername string
		AdminPassword string
	}
	Data struct {
		Dir string // resolved at boot
	}
}

func (c *Config) PortStr() string { return strconv.Itoa(c.Server.Port) }

// loadConfig wires env vars (NOTFLIX_*) and a minimal datadir layout. The
// schema is small enough that we don't need viper yet — env vars do the job.
func loadConfig() (*Config, error) {
	cfg := &Config{}

	// Datadir — defaults to ~/.notflix-data, override with NOTFLIX_DATA_DIR
	// or NOTFLIX_DATADIR (k8s deploy uses /data).
	cfg.Data.Dir = firstNonEmpty(
		os.Getenv("NOTFLIX_DATA_DIR"),
		os.Getenv("NOTFLIX_DATADIR"),
		defaultDataDir(),
	)
	if err := os.MkdirAll(cfg.Data.Dir, 0o755); err != nil {
		return nil, err
	}

	// Server bind.
	cfg.Server.Host = firstNonEmpty(os.Getenv("NOTFLIX_SERVER_HOST"), "127.0.0.1")
	cfg.Server.Port = intOrDefault(os.Getenv("NOTFLIX_SERVER_PORT"), 43212)

	// TMDB key — required for any non-static endpoint to do real work, but
	// the binary still starts without it so you can boot the UI and add the
	// key from settings later.
	cfg.TMDB.APIKey = os.Getenv("NOTFLIX_TMDB_API_KEY")

	// TorBox + Prowlarr keys — same story. Backend exposes a /status that
	// tells the frontend which ones are configured.
	cfg.TorBox.APIKey = os.Getenv("NOTFLIX_TORBOX_API_KEY")
	cfg.Prowlarr.BaseURL = firstNonEmpty(os.Getenv("NOTFLIX_PROWLARR_URL"), "http://127.0.0.1:9696")
	cfg.Prowlarr.APIKey = os.Getenv("NOTFLIX_PROWLARR_API_KEY")

	// Auth bootstrap — defaults are intentionally weak so a fresh
	// install boots without setup; the README tells the user to set
	// real values in `.env` and reset the password from the admin UI.
	cfg.Auth.AdminUsername = firstNonEmpty(os.Getenv("NOTFLIX_ADMIN_USERNAME"), "admin")
	cfg.Auth.AdminPassword = firstNonEmpty(os.Getenv("NOTFLIX_ADMIN_PASSWORD"), "admin")

	return cfg, nil
}

func (c *Config) requireTMDBKey() error {
	if c.TMDB.APIKey == "" {
		return errors.New("NOTFLIX_TMDB_API_KEY not set — register at https://www.themoviedb.org/settings/api")
	}
	return nil
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "./.notflix-data"
	}
	return filepath.Join(home, ".notflix-data")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func intOrDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}
