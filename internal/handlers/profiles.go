package handlers

import (
	"log"
	"strconv"

	"notflix/internal/database/models"

	"github.com/labstack/echo/v4"
)

// Same pattern as Kuro: the client sends a UUID it generates locally, so
// switching profiles is instant (no round-trip to read back an auto-id).

func (h *Handler) HandleListProfiles(c echo.Context) error {
	profiles, err := h.App.Database.ListProfiles()
	if err != nil {
		return RespondErr(c, err)
	}
	if profiles == nil {
		profiles = []*models.Profile{}
	}
	return RespondOK(c, profiles)
}

func (h *Handler) HandleCreateProfile(c echo.Context) error {
	var body struct {
		UID    string `json:"uid"`
		Name   string `json:"name"`
		Avatar string `json:"avatar"`
		Color  string `json:"color"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	p, err := h.App.Database.CreateProfile(&models.Profile{
		UID: body.UID, Name: body.Name, Avatar: body.Avatar, Color: body.Color,
	})
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, p)
}

func (h *Handler) HandleUpdateProfile(c echo.Context) error {
	var body struct {
		Name, Avatar, Color string
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	p, err := h.App.Database.UpdateProfile(c.Param("uid"), body.Name, body.Avatar, body.Color)
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, p)
}

func (h *Handler) HandleDeleteProfile(c echo.Context) error {
	if err := h.App.Database.DeleteProfile(c.Param("uid")); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}

// -----------------------------------------------------------------------------
// Watch history
// -----------------------------------------------------------------------------

func (h *Handler) HandleListHistory(c echo.Context) error {
	items, err := h.App.Database.ListWatchHistory(c.Param("uid"))
	if err != nil {
		return RespondErr(c, err)
	}
	if items == nil {
		items = []*models.ProfileWatchHistory{}
	}
	return RespondOK(c, items)
}

func (h *Handler) HandleUpsertHistory(c echo.Context) error {
	uid := c.Param("uid")
	var body struct {
		TMDBID          int     `json:"tmdbId"`
		MediaType       string  `json:"mediaType"`
		Season          int     `json:"season"`
		Episode         int     `json:"episode"`
		CurrentTime     float64 `json:"currentTime"`
		Duration        float64 `json:"duration"`
		Title           string  `json:"title"`
		PosterPath      string  `json:"posterPath"`
		BackdropURL     string  `json:"backdropUrl"`
		ReleaseName     string  `json:"releaseName"`
		ReleaseSource   string  `json:"releaseSource"`
		ReleaseInfoHash string  `json:"releaseInfoHash"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	item := &models.ProfileWatchHistory{
		ProfileUID:      uid,
		TMDBID:          body.TMDBID,
		MediaType:       body.MediaType,
		Season:          body.Season,
		Episode:         body.Episode,
		CurrentTime:     body.CurrentTime,
		Duration:        body.Duration,
		Title:           body.Title,
		PosterPath:      body.PosterPath,
		BackdropURL:     body.BackdropURL,
		ReleaseName:     body.ReleaseName,
		ReleaseSource:   body.ReleaseSource,
		ReleaseInfoHash: body.ReleaseInfoHash,
	}
	saved, err := h.App.Database.UpsertWatchHistory(item)
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, saved)
}

func (h *Handler) HandleClearHistory(c echo.Context) error {
	if err := h.App.Database.ClearWatchHistory(c.Param("uid")); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}

// HandleMarkSeriesWatched — POST /api/v1/profiles/:uid/history/mark-series
//
// Mass-upserts a watch history row per (season, episode) pair so the
// whole series shows as finished. Body:
//
//	{
//	  tmdbId, title, posterPath, backdropUrl,
//	  seasons: [{season: 1, episodes: 10}, {season: 2, episodes: 8}, ...]
//	}
//
// Each row is written with currentTime == duration == 3600 (sentinel
// "finished" — the Continue Watching filter trims rows where the
// remaining is under 60 s). Returns {marked: count}.
//
// We don't fetch real episode durations from TMDB — the cost of N TMDB
// /tv/:id/season/:N calls isn't worth it just to bake an accurate
// duration into rows that exist solely to be filtered out of the
// "in progress" rail.
func (h *Handler) HandleMarkSeriesWatched(c echo.Context) error {
	uid := c.Param("uid")
	var body struct {
		TMDBID      int    `json:"tmdbId"`
		Title       string `json:"title"`
		PosterPath  string `json:"posterPath"`
		BackdropURL string `json:"backdropUrl"`
		Seasons     []struct {
			Season   int `json:"season"`
			Episodes int `json:"episodes"`
		} `json:"seasons"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	if body.TMDBID == 0 || len(body.Seasons) == 0 {
		return c.JSON(400, map[string]any{"error": "tmdbId + seasons required"})
	}

	marked := 0
	for _, s := range body.Seasons {
		if s.Episodes <= 0 || s.Season <= 0 {
			continue
		}
		for ep := 1; ep <= s.Episodes; ep++ {
			item := &models.ProfileWatchHistory{
				ProfileUID:  uid,
				TMDBID:      body.TMDBID,
				MediaType:   "tv",
				Season:      s.Season,
				Episode:     ep,
				CurrentTime: 3600,
				Duration:    3600,
				Title:       body.Title,
				PosterPath:  body.PosterPath,
				BackdropURL: body.BackdropURL,
			}
			if _, err := h.App.Database.UpsertWatchHistory(item); err != nil {
				// Keep going — one bad row shouldn't fail the whole batch.
				log.Printf("mark series: upsert S%dE%d failed: %v", s.Season, ep, err)
				continue
			}
			marked++
		}
	}
	return RespondOK(c, map[string]any{"marked": marked})
}

func (h *Handler) HandleDeleteHistoryByMedia(c echo.Context) error {
	tmdbID, err := strconv.Atoi(c.Param("tmdbId"))
	if err != nil {
		return RespondErr(c, err)
	}
	if err := h.App.Database.DeleteWatchHistoryByMedia(c.Param("uid"), tmdbID, c.Param("mediaType")); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}

// -----------------------------------------------------------------------------
// Profile list ("Mes listes" per profile)
// -----------------------------------------------------------------------------

func (h *Handler) HandleListProfileList(c echo.Context) error {
	items, err := h.App.Database.ListProfileList(c.Param("uid"))
	if err != nil {
		return RespondErr(c, err)
	}
	if items == nil {
		items = []*models.ProfileListEntry{}
	}
	return RespondOK(c, items)
}

func (h *Handler) HandleUpsertProfileList(c echo.Context) error {
	uid := c.Param("uid")
	var body struct {
		TMDBID     int    `json:"tmdbId"`
		MediaType  string `json:"mediaType"`
		Status     string `json:"status"`
		Title      string `json:"title"`
		PosterPath string `json:"posterPath"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	saved, err := h.App.Database.UpsertProfileList(&models.ProfileListEntry{
		ProfileUID: uid,
		TMDBID:     body.TMDBID,
		MediaType:  body.MediaType,
		Status:     body.Status,
		Title:      body.Title,
		PosterPath: body.PosterPath,
	})
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, saved)
}

func (h *Handler) HandleDeleteProfileListEntry(c echo.Context) error {
	tmdbID, err := strconv.Atoi(c.Param("tmdbId"))
	if err != nil {
		return RespondErr(c, err)
	}
	if err := h.App.Database.DeleteProfileListEntry(c.Param("uid"), tmdbID, c.Param("mediaType")); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}
