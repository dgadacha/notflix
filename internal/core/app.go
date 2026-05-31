package core

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"notflix/internal/anthropic"
	"notflix/internal/database/db"
	"notflix/internal/database/models"
	"notflix/internal/library"
	"notflix/internal/prowlarr"
	"notflix/internal/tmdb"
	"notflix/internal/torbox"

	"golang.org/x/crypto/bcrypt"
)

// App is the singleton wiring container. Handlers get a *App so they can
// reach everything without passing 5+ args around.
type App struct {
	Config    *Config
	Database  *db.Database
	TMDB      *tmdb.Client
	TorBox    *torbox.Client
	Prowlarr  *prowlarr.Client
	Anthropic *anthropic.Client

	// libraryWatcher is started when Library.Dir is non-empty (either
	// at boot or after ApplyLibraryDir hot-swaps the path). nil if no
	// library dir is configured.
	libWatcherMu sync.Mutex
	libWatcher   *library.Watcher

	// torrentWatcher is the parallel watcher on the dedicated
	// .torrent drop dir. Same hot-swap pattern.
	torrentWatcherMu sync.Mutex
	torrentWatcher   *library.TorrentWatcher
}

// Setting keys used by the admin UI to override env-var defaults.
// They live in the `settings` table; the env vars are still read at
// boot so a fresh install works without touching the DB.
const (
	SettingTMDBAPIKey      = "tmdb_api_key"
	SettingTorBoxAPIKey    = "torbox_api_key"
	SettingProwlarrURL     = "prowlarr_url"
	SettingProwlarrAPIKey  = "prowlarr_api_key"
	SettingAnthropicAPIKey = "anthropic_api_key"
	SettingAnthropicModel  = "anthropic_model"
	SettingLibraryDir      = "local_library_dir"
	// SettingLibraryTorrentDropDir — when non-empty, a separate
	// fsnotify watcher picks up any .torrent file that lands in
	// this directory and runs it through the same import pipeline
	// as the manual "Importer un .torrent" button. Use case : you
	// download a .torrent from your indexer of choice, drop it
	// here, and it ends up in your Notflix library a minute later
	// without you ever opening the app.
	SettingLibraryTorrentDropDir = "library_torrent_drop_dir"
	// SettingLibraryAutoConvert — when "true", any successful scan
	// (manual or fsnotify-triggered) chain-triggers the MKV→MP4
	// batch converter. Default off so existing installs keep their
	// behaviour until the admin opts in.
	SettingLibraryAutoConvert = "library_auto_convert"
	// SettingLibraryAudioLangDefault — preferred audio language
	// (ISO 639-2 code, e.g. "fre"/"eng"/"jpn"/"spa") for non-anime
	// titles. The converter reorders MP4 audio tracks so this lang
	// lands at track 0, which means browsers (Chrome especially)
	// play it by default without any UI plumbing. "" = leave the
	// source order untouched.
	SettingLibraryAudioLangDefault = "library_audio_lang_default"
	// SettingLibraryAudioLangAnime — same but applied when the
	// title is detected as a Japanese animation (TMDB genre +
	// original_language check). Lets the user run films in VF and
	// anime in VO simultaneously.
	SettingLibraryAudioLangAnime = "library_audio_lang_anime"
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
		Config:    cfg,
		Database:  database,
		TMDB:      tmdb.NewClient(cfg.TMDB.APIKey),
		TorBox:    torbox.NewClient(cfg.TorBox.APIKey),
		Prowlarr:  prowlarr.NewClient(cfg.Prowlarr.BaseURL, cfg.Prowlarr.APIKey),
		Anthropic: anthropic.NewClient(cfg.Anthropic.APIKey, cfg.Anthropic.Model),
	}

	// Bootstrap the admin user on first boot. If the table is empty,
	// create one with the env-var credentials (defaulting to admin /
	// admin so a fresh install lets the user in immediately — the
	// README warns to change it).
	if err := app.bootstrapAdmin(); err != nil {
		return nil, err
	}

	// Sweep TMDB cache on boot then hourly. Keeps the DB size in
	// check; expired rows are silently filtered by reads anyway, this
	// just frees the rows.
	go app.tmdbCacheReaper()

	// Watch the local library directory for new files. Best-effort —
	// a watcher failure is logged but doesn't abort startup (the user
	// can always trigger manual scans from the settings UI).
	app.startLibraryWatcher()
	app.startTorrentWatcher()

	// Chain MKV→MP4 batch conversion after every successful scan
	// when the admin opts in. The hook itself checks the toggle on
	// every fire (no in-memory cache to refresh on settings change).
	// TryStartConvertBatch is a no-op if a batch is already running,
	// so back-to-back scans don't stack convert jobs.
	library.SetAfterScanHook(func() {
		if !app.AutoConvertEnabled() {
			return
		}
		if library.TryStartConvertBatch(app.Database, app.NewAudioLangPicker()) {
			log.Printf("library auto-convert: kicked off batch after scan")
		}
	})

	return app, nil
}

// startLibraryWatcher arms the fsnotify watcher on the configured
// library directory. No-op if the dir is empty. Replaces any
// previously-running watcher (so ApplyLibraryDir can call this on
// every dir change).
func (a *App) startLibraryWatcher() {
	a.libWatcherMu.Lock()
	defer a.libWatcherMu.Unlock()

	if a.libWatcher != nil {
		a.libWatcher.Stop()
		a.libWatcher = nil
	}
	dir := a.Config.Library.Dir
	if dir == "" {
		return
	}
	w, err := library.NewWatcher(dir, a.TMDB, a.Database)
	if err != nil {
		log.Printf("library watcher: %v (auto-scan disabled until next dir change)", err)
		return
	}
	if err := w.Start(); err != nil {
		log.Printf("library watcher: start: %v", err)
		_ = w
		return
	}
	a.libWatcher = w
}

// tmdbCacheReaper drops expired TMDB cache rows on a 1 h ticker.
// Runs forever as a daemon goroutine; an error in any sweep is logged
// but doesn't stop the loop.
func (a *App) tmdbCacheReaper() {
	sweep := func() {
		n, err := a.Database.PurgeExpiredTMDBCache()
		if err != nil {
			log.Printf("tmdb cache reaper: %v", err)
			return
		}
		if n > 0 {
			log.Printf("tmdb cache reaper: purged %d expired rows", n)
		}
	}
	sweep() // initial sweep so a long-running install doesn't accumulate forever
	t := time.NewTicker(1 * time.Hour)
	defer t.Stop()
	for range t.C {
		sweep()
	}
}

// overlaySettingsOnto reads the admin-mutable keys from the DB and
// patches them into the Config struct. Empty / missing rows leave the
// env-var value untouched. Silent on DB errors — if the settings table
// is unreadable the env values are still a working fallback.
func overlaySettingsOnto(database *db.Database, cfg *Config) {
	rows, err := database.GetSettings([]string{
		SettingTMDBAPIKey,
		SettingTorBoxAPIKey,
		SettingProwlarrURL,
		SettingProwlarrAPIKey,
		SettingAnthropicAPIKey,
		SettingAnthropicModel,
		SettingLibraryDir,
		SettingLibraryAudioLangDefault,
		SettingLibraryAudioLangAnime,
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
	if v := rows[SettingAnthropicAPIKey]; v != "" {
		cfg.Anthropic.APIKey = v
	}
	if v := rows[SettingAnthropicModel]; v != "" {
		cfg.Anthropic.Model = v
	}
	if v := rows[SettingLibraryDir]; v != "" {
		cfg.Library.Dir = v
	}
}

// AutoConvertEnabled reads the toggle from the settings table.
// Defaults to false on read errors or unset rows.
func (a *App) AutoConvertEnabled() bool {
	rows, err := a.Database.GetSettings([]string{SettingLibraryAutoConvert})
	if err != nil {
		return false
	}
	return rows[SettingLibraryAutoConvert] == "true"
}

// ApplyAutoConvert persists the toggle. The next scan completion
// hook reads it fresh, so there's no in-memory cache to refresh.
func (a *App) ApplyAutoConvert(enabled bool) error {
	val := "false"
	if enabled {
		val = "true"
	}
	return a.Database.SetSetting(SettingLibraryAutoConvert, val)
}

// AudioLangPrefs reads the (default, anime) preferred audio language
// codes from the settings table. Empty strings mean "leave the source
// order untouched" — the converter then maps tracks in original order.
// Sensible defaults: fre for the general case, jpn for anime.
func (a *App) AudioLangPrefs() (def, anime string) {
	rows, err := a.Database.GetSettings([]string{
		SettingLibraryAudioLangDefault,
		SettingLibraryAudioLangAnime,
	})
	if err != nil {
		return "fre", "jpn"
	}
	def = rows[SettingLibraryAudioLangDefault]
	anime = rows[SettingLibraryAudioLangAnime]
	if def == "" {
		def = "fre"
	}
	if anime == "" {
		anime = "jpn"
	}
	return def, anime
}

// ApplyAudioLangPrefs persists both preferences in a single call. Pass
// "" to either field to clear the override (the default code applies
// on next read).
func (a *App) ApplyAudioLangPrefs(def, anime string) error {
	if err := a.Database.SetSetting(SettingLibraryAudioLangDefault, strings.ToLower(strings.TrimSpace(def))); err != nil {
		return err
	}
	return a.Database.SetSetting(SettingLibraryAudioLangAnime, strings.ToLower(strings.TrimSpace(anime)))
}

// IsAnime is a best-effort check: does this TMDB title look like
// Japanese animation? We require BOTH genre 16 (Animation) AND
// original_language == "ja" so US cartoons / Pixar films don't get
// labelled "anime" and converted to a Japanese audio they don't have.
//
// Returns false on any TMDB error or unrecognised mediaType — that's
// the safe default (no special treatment, falls back to the general
// preferred lang).
//
// Logs the path it took so the admin can debug "why didn't my anime
// get treated as anime?" without recompiling.
func (a *App) IsAnime(mediaType string, tmdbID int) bool {
	if tmdbID <= 0 {
		log.Printf("is-anime: skip — tmdbID=%d (file not matched against TMDB at scan time?)", tmdbID)
		return false
	}
	// Leading slash matters: the TMDB client concatenates baseURL +
	// path verbatim, so "tv/N" produces ".../3tv/N" (broken). Other
	// call sites (tmdb_proxy, admin_diagnostics) pass "/path" — we
	// just have to follow the same convention.
	var endpoint string
	switch mediaType {
	case "tv":
		endpoint = fmt.Sprintf("/tv/%d", tmdbID)
	case "movie":
		endpoint = fmt.Sprintf("/movie/%d", tmdbID)
	default:
		log.Printf("is-anime: skip — unknown mediaType=%q (tmdbID=%d)", mediaType, tmdbID)
		return false
	}
	var data struct {
		OriginalLanguage string `json:"original_language"`
		Genres           []struct {
			ID   int    `json:"id"`
			Name string `json:"name"`
		} `json:"genres"`
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.TMDB.GetJSON(ctx, endpoint, nil, &data); err != nil {
		log.Printf("is-anime: TMDB %q failed: %v", endpoint, err)
		return false
	}
	genreNames := make([]string, len(data.Genres))
	for i, g := range data.Genres {
		genreNames[i] = fmt.Sprintf("%d:%s", g.ID, g.Name)
	}
	hasAnimationGenre := false
	for _, g := range data.Genres {
		if g.ID == 16 {
			hasAnimationGenre = true
			break
		}
	}
	result := data.OriginalLanguage == "ja" && hasAnimationGenre
	log.Printf("is-anime: %s → lang=%q genres=[%s] → anime=%v",
		endpoint, data.OriginalLanguage, strings.Join(genreNames, ", "), result)
	return result
}

// NewAudioLangPicker returns a closure that maps a LocalFile to the
// preferred audio language code. Calls IsAnime once per file. Used
// by both the manual /convert handler and the auto-trigger hook —
// keeps the "what lang for this file" policy in a single place.
func (a *App) NewAudioLangPicker() func(*models.LocalFile) string {
	def, anime := a.AudioLangPrefs()
	return func(f *models.LocalFile) string {
		isAnime := a.IsAnime(f.MediaType, f.TMDBID)
		picked := def
		if isAnime {
			picked = anime
		}
		log.Printf("audio-lang: %s (tmdb=%d type=%q) → anime=%v lang=%q",
			filepath.Base(f.Path), f.TMDBID, f.MediaType, isAnime, picked)
		return picked
	}
}

// TorrentDropDir reads the setting from DB. Empty means feature off.
func (a *App) TorrentDropDir() string {
	rows, err := a.Database.GetSettings([]string{SettingLibraryTorrentDropDir})
	if err != nil {
		return ""
	}
	return rows[SettingLibraryTorrentDropDir]
}

// ApplyTorrentDropDir persists the new dir and hot-swaps the watcher.
// Empty dir = stop the watcher (feature off).
func (a *App) ApplyTorrentDropDir(dir string) error {
	if err := a.Database.SetSetting(SettingLibraryTorrentDropDir, dir); err != nil {
		return err
	}
	a.startTorrentWatcher()
	return nil
}

// startTorrentWatcher (re)starts the watcher on whatever dir is
// currently configured. Replaces any previous instance.
func (a *App) startTorrentWatcher() {
	a.torrentWatcherMu.Lock()
	defer a.torrentWatcherMu.Unlock()

	if a.torrentWatcher != nil {
		a.torrentWatcher.Stop()
		a.torrentWatcher = nil
	}
	dir := a.TorrentDropDir()
	if dir == "" {
		return
	}
	w, err := library.NewTorrentWatcher(dir, a.TorBox, a.Database, a.TMDB)
	if err != nil {
		log.Printf("torrent watcher: %v (auto-import disabled)", err)
		return
	}
	if err := w.Start(); err != nil {
		log.Printf("torrent watcher: start: %v", err)
		return
	}
	a.torrentWatcher = w
}

// ApplyLibraryDir is the hot-swap path the admin UI hits when the user
// changes the local-library directory. Persists to the settings table
// and updates the in-memory config. Empty string clears the setting
// (the env var, if any, becomes the source of truth on next reboot).
func (a *App) ApplyLibraryDir(dir string) error {
	if err := a.Database.SetSetting(SettingLibraryDir, dir); err != nil {
		return err
	}
	a.Config.Library.Dir = dir
	// Re-arm the fsnotify watcher on the new dir (or stop it if dir
	// was cleared). Same goroutine model as startup.
	a.startLibraryWatcher()
	return nil
}

// ApplyServerConfig writes the admin-mutable keys to the settings
// table, updates the in-memory Config, and hot-swaps the credentials
// inside each client. Empty strings clear the corresponding setting so
// the next boot falls back to the env-var (or, if no env-var, an
// unconfigured client that the /status endpoint flags as missing).
//
// Caller must hold the admin role check — the App layer doesn't
// re-check, it trusts handlers/auth.go's RequireAdmin.
func (a *App) ApplyServerConfig(tmdbKey, torboxKey, prowlarrURL, prowlarrKey, anthropicKey, anthropicModel string) error {
	pairs := []struct {
		key, val string
	}{
		{SettingTMDBAPIKey, tmdbKey},
		{SettingTorBoxAPIKey, torboxKey},
		{SettingProwlarrURL, prowlarrURL},
		{SettingProwlarrAPIKey, prowlarrKey},
		{SettingAnthropicAPIKey, anthropicKey},
		{SettingAnthropicModel, anthropicModel},
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
	a.Config.Anthropic.APIKey = anthropicKey
	a.Config.Anthropic.Model = anthropicModel
	a.TMDB.SetAPIKey(tmdbKey)
	a.TorBox.SetAPIKey(torboxKey)
	a.Prowlarr.SetConfig(prowlarrURL, prowlarrKey)
	a.Anthropic.SetCredentials(anthropicKey, anthropicModel)
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
	a.libWatcherMu.Lock()
	if a.libWatcher != nil {
		a.libWatcher.Stop()
		a.libWatcher = nil
	}
	a.libWatcherMu.Unlock()
	a.torrentWatcherMu.Lock()
	if a.torrentWatcher != nil {
		a.torrentWatcher.Stop()
		a.torrentWatcher = nil
	}
	a.torrentWatcherMu.Unlock()
	if a.Database != nil {
		_ = a.Database.Close()
	}
}
