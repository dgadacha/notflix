package models

import "time"

type BaseModel struct {
	ID        uint      `gorm:"primarykey" json:"id"`
	CreatedAt time.Time `json:"createdAt"`
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
