// Notflix: HTTP handlers for Netflix-style profiles + watch history.
//
// All routes are server-state CRUD over SQLite (the same DB the rest of seanime
// uses). The frontend sends a client-generated UUID as the `uid` so a profile
// switch is instantaneous (no round-trip needed to read back an auto-id).
package handlers

import (
	"notflix/internal/database/models"
	"strconv"

	"github.com/labstack/echo/v4"
)

// HandleListNotflixProfiles
//
//	@summary returns all profiles ordered by creation date.
//	@route /api/v1/notflix-profiles [GET]
//	@returns []models.NotflixProfile
func (h *Handler) HandleListNotflixProfiles(c echo.Context) error {
	profiles, err := h.App.Database.ListNotflixProfiles()
	if err != nil {
		return h.RespondWithError(c, err)
	}
	if profiles == nil {
		profiles = []*models.NotflixProfile{}
	}
	return h.RespondWithData(c, profiles)
}

// HandleCreateNotflixProfile
//
//	@summary creates a new profile.
//	@route /api/v1/notflix-profiles [POST]
//	@returns models.NotflixProfile
func (h *Handler) HandleCreateNotflixProfile(c echo.Context) error {
	var body struct {
		UID    string `json:"uid"`
		Name   string `json:"name"`
		Avatar string `json:"avatar"`
		Color  string `json:"color"`
	}
	if err := c.Bind(&body); err != nil {
		return h.RespondWithError(c, err)
	}

	created, err := h.App.Database.CreateNotflixProfile(&models.NotflixProfile{
		UID:    body.UID,
		Name:   body.Name,
		Avatar: body.Avatar,
		Color:  body.Color,
	})
	if err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, created)
}

// HandleUpdateNotflixProfile
//
//	@summary patches a profile's mutable fields.
//	@route /api/v1/notflix-profiles/{uid} [PATCH]
//	@returns models.NotflixProfile
func (h *Handler) HandleUpdateNotflixProfile(c echo.Context) error {
	uid := c.Param("uid")
	var body struct {
		Name   string `json:"name"`
		Avatar string `json:"avatar"`
		Color  string `json:"color"`
	}
	if err := c.Bind(&body); err != nil {
		return h.RespondWithError(c, err)
	}
	updated, err := h.App.Database.UpdateNotflixProfile(uid, body.Name, body.Avatar, body.Color)
	if err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, updated)
}

// HandleDeleteNotflixProfile
//
//	@summary removes a profile and its watch history.
//	@route /api/v1/notflix-profiles/{uid} [DELETE]
//	@returns bool
func (h *Handler) HandleDeleteNotflixProfile(c echo.Context) error {
	uid := c.Param("uid")
	if err := h.App.Database.DeleteNotflixProfile(uid); err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, true)
}

// HandleListNotflixProfileHistory
//
//	@summary returns the watch history for a profile, most-recent first.
//	@route /api/v1/notflix-profiles/{uid}/history [GET]
//	@returns []models.NotflixProfileWatchHistory
func (h *Handler) HandleListNotflixProfileHistory(c echo.Context) error {
	uid := c.Param("uid")
	items, err := h.App.Database.ListNotflixProfileWatchHistory(uid)
	if err != nil {
		return h.RespondWithError(c, err)
	}
	if items == nil {
		items = []*models.NotflixProfileWatchHistory{}
	}
	return h.RespondWithData(c, items)
}

// HandleUpsertNotflixProfileHistoryItem
//
//	@summary inserts or updates a single (profile, media) watch entry.
//	@route /api/v1/notflix-profiles/{uid}/history [PUT]
//	@returns models.NotflixProfileWatchHistory
func (h *Handler) HandleUpsertNotflixProfileHistoryItem(c echo.Context) error {
	uid := c.Param("uid")
	var body struct {
		MediaID       int     `json:"mediaId"`
		EpisodeNumber int     `json:"episodeNumber"`
		CurrentTime   float64 `json:"currentTime"`
		Duration      float64 `json:"duration"`
	}
	if err := c.Bind(&body); err != nil {
		return h.RespondWithError(c, err)
	}
	saved, err := h.App.Database.UpsertNotflixProfileWatchHistoryItem(&models.NotflixProfileWatchHistory{
		ProfileUID:    uid,
		MediaID:       body.MediaID,
		EpisodeNumber: body.EpisodeNumber,
		CurrentTime:   body.CurrentTime,
		Duration:      body.Duration,
	})
	if err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, saved)
}

// HandleDeleteNotflixProfileHistoryItem
//
//	@summary removes ALL watch entries for a (profile, media) pair (i.e. the
//	         whole series, every episode).
//	@route /api/v1/notflix-profiles/{uid}/history/{mediaId} [DELETE]
//	@returns bool
func (h *Handler) HandleDeleteNotflixProfileHistoryItem(c echo.Context) error {
	uid := c.Param("uid")
	mediaID, err := strconv.Atoi(c.Param("mediaId"))
	if err != nil {
		return h.RespondWithError(c, err)
	}
	if err := h.App.Database.DeleteNotflixProfileWatchHistoryItem(uid, mediaID); err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, true)
}

// HandleDeleteNotflixProfileHistoryEpisode
//
//	@summary removes a single watched-episode row.
//	@route /api/v1/notflix-profiles/{uid}/history/{mediaId}/episode/{episodeNumber} [DELETE]
//	@returns bool
func (h *Handler) HandleDeleteNotflixProfileHistoryEpisode(c echo.Context) error {
	uid := c.Param("uid")
	mediaID, err := strconv.Atoi(c.Param("mediaId"))
	if err != nil {
		return h.RespondWithError(c, err)
	}
	episodeNumber, err := strconv.Atoi(c.Param("episodeNumber"))
	if err != nil {
		return h.RespondWithError(c, err)
	}
	if err := h.App.Database.DeleteNotflixProfileWatchHistoryEpisode(uid, mediaID, episodeNumber); err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, true)
}

// HandleClearNotflixProfileHistory
//
//	@summary wipes every history row for a profile (full reset).
//	@route /api/v1/notflix-profiles/{uid}/history [DELETE]
//	@returns bool
func (h *Handler) HandleClearNotflixProfileHistory(c echo.Context) error {
	uid := c.Param("uid")
	if err := h.App.Database.ClearNotflixProfileWatchHistory(uid); err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, true)
}

// HandleUpsertNotflixProfileHistoryItemPOST is the POST alias for the upsert
// endpoint. The browser's `navigator.sendBeacon` (used by the watch page on
// pagehide / visibility change) only ever fires POST, so we accept it here
// alongside PUT.
func (h *Handler) HandleUpsertNotflixProfileHistoryItemPOST(c echo.Context) error {
	return h.HandleUpsertNotflixProfileHistoryItem(c)
}

// -----------------------------------------------------------------------------
// Per-profile list (the "Mes listes" view, isolated per profile)
// -----------------------------------------------------------------------------

// HandleListNotflixProfileList
//
//	@summary returns the profile's list entries (one row per (profile, media)).
//	@route /api/v1/notflix-profiles/{uid}/list [GET]
//	@returns []models.NotflixProfileListEntry
func (h *Handler) HandleListNotflixProfileList(c echo.Context) error {
	uid := c.Param("uid")
	entries, err := h.App.Database.ListNotflixProfileListEntries(uid)
	if err != nil {
		return h.RespondWithError(c, err)
	}
	if entries == nil {
		entries = []*models.NotflixProfileListEntry{}
	}
	return h.RespondWithData(c, entries)
}

// HandleUpsertNotflixProfileListEntry
//
//	@summary inserts or updates the (profile, media) list row.
//	@route /api/v1/notflix-profiles/{uid}/list [PUT]
//	@returns models.NotflixProfileListEntry
func (h *Handler) HandleUpsertNotflixProfileListEntry(c echo.Context) error {
	uid := c.Param("uid")
	var body struct {
		MediaID int    `json:"mediaId"`
		Status  string `json:"status"`
	}
	if err := c.Bind(&body); err != nil {
		return h.RespondWithError(c, err)
	}
	saved, err := h.App.Database.UpsertNotflixProfileListEntry(&models.NotflixProfileListEntry{
		ProfileUID: uid,
		MediaID:    body.MediaID,
		Status:     body.Status,
	})
	if err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, saved)
}

// HandleDeleteNotflixProfileListEntry
//
//	@summary removes one media from this profile's list (does not touch AniList).
//	@route /api/v1/notflix-profiles/{uid}/list/{mediaId} [DELETE]
//	@returns bool
func (h *Handler) HandleDeleteNotflixProfileListEntry(c echo.Context) error {
	uid := c.Param("uid")
	mediaID, err := strconv.Atoi(c.Param("mediaId"))
	if err != nil {
		return h.RespondWithError(c, err)
	}
	if err := h.App.Database.DeleteNotflixProfileListEntry(uid, mediaID); err != nil {
		return h.RespondWithError(c, err)
	}
	return h.RespondWithData(c, true)
}
