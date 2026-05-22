package models

import "time"

type BaseModel struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// +---------------------+
// |       Auth          |
// +---------------------+

// User is a login account. The admin (one per install, bootstrapped via
// NOTFLIX_ADMIN_USERNAME / NOTFLIX_ADMIN_PASSWORD env vars) can create
// "child" users — non-admin accounts with the same browsing surface but
// no admin actions.
type User struct {
	BaseModel
	Username     string `gorm:"column:username;uniqueIndex;size:64;not null" json:"username"`
	PasswordHash string `gorm:"column:password_hash;size:255;not null" json:"-"`
	IsAdmin      bool   `gorm:"column:is_admin;default:false" json:"isAdmin"`
	DisplayName  string `gorm:"column:display_name;size:64" json:"displayName"`
}

// Session is a server-side opaque token issued at login and looked up on
// every request. Lives in the DB so revocation works (admin deletes a
// user → their sessions vanish in the same transaction).
type Session struct {
	Token     string    `gorm:"primarykey;size:64" json:"-"`
	UserID    uint      `gorm:"column:user_id;not null;index" json:"userId"`
	ExpiresAt time.Time `gorm:"column:expires_at;index" json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
}

// Setting is a single key/value pair used to store admin-mutable server
// configuration (TMDB / TorBox / Prowlarr keys). Env vars are still the
// initial fallback; if a setting is written from the admin UI the DB
// value overrides the env on subsequent boots.
type Setting struct {
	Key       string    `gorm:"primarykey;size:64" json:"key"`
	Value     string    `gorm:"column:value;type:text" json:"value"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// +---------------------+
// |     Profiles        |
// +---------------------+

type Profile struct {
	BaseModel
	UID    string `gorm:"column:uid;uniqueIndex;size:64;not null" json:"uid"`
	Name   string `gorm:"column:name;size:30;not null" json:"name"`
	Avatar string `gorm:"column:avatar;size:16" json:"avatar"`
	Color  string `gorm:"column:color;size:16" json:"color"`
}

// Watch history is per (profile, tmdbId, mediaType). For movies, episode is
// always 0; for TV shows we store (season, episode) so resume works at the
// episode level.
type ProfileWatchHistory struct {
	BaseModel
	ProfileUID string `gorm:"column:profile_uid;size:64;not null;uniqueIndex:idx_profile_media,priority:1" json:"profileUid"`
	TMDBID     int    `gorm:"column:tmdb_id;not null;uniqueIndex:idx_profile_media,priority:2" json:"tmdbId"`
	// "movie" | "tv"
	MediaType   string  `gorm:"column:media_type;size:8;not null;uniqueIndex:idx_profile_media,priority:3" json:"mediaType"`
	Season      int     `gorm:"column:season;default:0;uniqueIndex:idx_profile_media,priority:4" json:"season"`
	Episode     int     `gorm:"column:episode;default:0;uniqueIndex:idx_profile_media,priority:5" json:"episode"`
	CurrentTime float64 `gorm:"column:current_time" json:"currentTime"`
	Duration    float64 `gorm:"column:duration" json:"duration"`
	// Denormalised so the home rows can render without re-hitting TMDB.
	Title       string `gorm:"column:title;size:255" json:"title"`
	PosterPath  string `gorm:"column:poster_path;size:255" json:"posterPath"`
	BackdropURL string `gorm:"column:backdrop_url;size:255" json:"backdropUrl"`
	// Identifies the specific release that produced this stream — without
	// these the resume path would re-run the Prowlarr search and could
	// land on a different file (different duration, different audio).
	// Saved on every history upsert so even a mid-film source switch is
	// captured.
	ReleaseName     string `gorm:"column:release_name;size:512" json:"releaseName"`
	ReleaseSource   string `gorm:"column:release_source;size:4096" json:"releaseSource"`
	ReleaseInfoHash string `gorm:"column:release_info_hash;size:64" json:"releaseInfoHash"`
}

// Per-profile list of "to watch" / "currently watching" / etc.
type ProfileListEntry struct {
	BaseModel
	ProfileUID string `gorm:"column:profile_uid;size:64;not null;uniqueIndex:idx_profile_list,priority:1" json:"profileUid"`
	TMDBID     int    `gorm:"column:tmdb_id;not null;uniqueIndex:idx_profile_list,priority:2" json:"tmdbId"`
	MediaType  string `gorm:"column:media_type;size:8;not null;uniqueIndex:idx_profile_list,priority:3" json:"mediaType"`
	// "WATCHING" | "PLANNING" | "COMPLETED" | "DROPPED"
	Status     string `gorm:"column:status;size:16;not null" json:"status"`
	Title      string `gorm:"column:title;size:255" json:"title"`
	PosterPath string `gorm:"column:poster_path;size:255" json:"posterPath"`
}

// TMDBCacheEntry persists TMDB API responses so home/detail pages stay
// snappy across restarts and survive bursts beyond the 30 s in-memory
// window of tmdb.Client. URLHash is sha256(path + sorted query params
// minus api_key) — so rotating the API key doesn't invalidate cache.
//
// TTL is path-dependent (see tmdbCacheTTL in handlers/tmdb_proxy.go).
// A background reaper sweeps expired rows hourly.
type TMDBCacheEntry struct {
	URLHash   string    `gorm:"column:url_hash;primaryKey;size:64" json:"urlHash"`
	Path      string    `gorm:"column:path;size:255" json:"path"` // For debugging / metrics
	Body      []byte    `gorm:"column:body" json:"body"`
	ExpiresAt time.Time `gorm:"column:expires_at;index" json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
}
