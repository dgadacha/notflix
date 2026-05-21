// Notflix: CRUD for Netflix-style profiles + per-profile watch history.
//
// Two tables, both keyed by a client-friendly string `uid` (uuid). The frontend
// generates the uid client-side and uses it as the stable handle so a profile
// switch doesn't require a round-trip to the server.
package db

import (
	"errors"
	"notflix/internal/database/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// -----------------------------------------------------------------------------
// Profile CRUD
// -----------------------------------------------------------------------------

func (db *Database) ListNotflixProfiles() ([]*models.NotflixProfile, error) {
	var res []*models.NotflixProfile
	err := db.gormdb.Order("created_at ASC").Find(&res).Error
	if err != nil {
		return nil, err
	}
	return res, nil
}

func (db *Database) GetNotflixProfileByUID(uid string) (*models.NotflixProfile, error) {
	if uid == "" {
		return nil, errors.New("profile uid required")
	}
	var p models.NotflixProfile
	err := db.gormdb.Where("uid = ?", uid).First(&p).Error
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// CreateNotflixProfile inserts a new profile. Returns the created row (with auto
// id + timestamps populated).
func (db *Database) CreateNotflixProfile(p *models.NotflixProfile) (*models.NotflixProfile, error) {
	if p == nil {
		return nil, errors.New("profile required")
	}
	if p.UID == "" {
		return nil, errors.New("profile uid required")
	}
	if p.Name == "" {
		return nil, errors.New("profile name required")
	}
	if err := db.gormdb.Create(p).Error; err != nil {
		return nil, err
	}
	return p, nil
}

// UpdateNotflixProfile patches the mutable fields of a profile. Returns the
// refreshed row.
func (db *Database) UpdateNotflixProfile(uid string, name, avatar, color string) (*models.NotflixProfile, error) {
	p, err := db.GetNotflixProfileByUID(uid)
	if err != nil {
		return nil, err
	}
	updates := map[string]interface{}{}
	if name != "" {
		updates["name"] = name
	}
	if avatar != "" {
		updates["avatar"] = avatar
	}
	if color != "" {
		updates["color"] = color
	}
	if len(updates) == 0 {
		return p, nil
	}
	if err := db.gormdb.Model(p).Updates(updates).Error; err != nil {
		return nil, err
	}
	return db.GetNotflixProfileByUID(uid)
}

// DeleteNotflixProfile removes the profile and its watch history in one transaction.
func (db *Database) DeleteNotflixProfile(uid string) error {
	if uid == "" {
		return errors.New("profile uid required")
	}
	return db.gormdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("profile_uid = ?", uid).Delete(&models.NotflixProfileWatchHistory{}).Error; err != nil {
			return err
		}
		return tx.Where("uid = ?", uid).Delete(&models.NotflixProfile{}).Error
	})
}

// -----------------------------------------------------------------------------
// Watch history per profile
// -----------------------------------------------------------------------------

func (db *Database) ListNotflixProfileWatchHistory(profileUID string) ([]*models.NotflixProfileWatchHistory, error) {
	if profileUID == "" {
		return nil, errors.New("profile uid required")
	}
	var res []*models.NotflixProfileWatchHistory
	err := db.gormdb.
		Where("profile_uid = ?", profileUID).
		Order("updated_at DESC").
		Find(&res).Error
	if err != nil {
		return nil, err
	}
	return res, nil
}

// UpsertNotflixProfileWatchHistoryItem inserts or updates the
// (profile_uid, media_id, episode_number) row. Per-episode keying lets the
// history page surface each watched episode individually.
func (db *Database) UpsertNotflixProfileWatchHistoryItem(item *models.NotflixProfileWatchHistory) (*models.NotflixProfileWatchHistory, error) {
	if item == nil {
		return nil, errors.New("item required")
	}
	if item.ProfileUID == "" {
		return nil, errors.New("profile uid required")
	}
	if item.MediaID == 0 {
		return nil, errors.New("media id required")
	}
	err := db.gormdb.
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "profile_uid"},
				{Name: "media_id"},
				{Name: "episode_number"},
			},
			DoUpdates: clause.AssignmentColumns([]string{
				"current_time",
				"duration",
				"updated_at",
			}),
		}).
		Create(item).Error
	if err != nil {
		return nil, err
	}
	// Re-fetch so we return the row with up-to-date timestamps.
	var refreshed models.NotflixProfileWatchHistory
	if err := db.gormdb.
		Where("profile_uid = ? AND media_id = ? AND episode_number = ?",
			item.ProfileUID, item.MediaID, item.EpisodeNumber).
		First(&refreshed).Error; err != nil {
		return nil, err
	}
	return &refreshed, nil
}

// DeleteNotflixProfileWatchHistoryItem removes ALL rows for this (profile, media)
// pair — i.e. every watched episode of this anime. Used by the "delete the
// whole series from history" action.
func (db *Database) DeleteNotflixProfileWatchHistoryItem(profileUID string, mediaID int) error {
	return db.gormdb.
		Where("profile_uid = ? AND media_id = ?", profileUID, mediaID).
		Delete(&models.NotflixProfileWatchHistory{}).Error
}

// DeleteNotflixProfileWatchHistoryEpisode removes a single (profile, media, episode)
// row. Used by the per-episode delete action.
func (db *Database) DeleteNotflixProfileWatchHistoryEpisode(profileUID string, mediaID, episodeNumber int) error {
	return db.gormdb.
		Where("profile_uid = ? AND media_id = ? AND episode_number = ?",
			profileUID, mediaID, episodeNumber).
		Delete(&models.NotflixProfileWatchHistory{}).Error
}

// ClearNotflixProfileWatchHistory wipes every watch entry for a profile.
func (db *Database) ClearNotflixProfileWatchHistory(profileUID string) error {
	if profileUID == "" {
		return errors.New("profile uid required")
	}
	return db.gormdb.
		Where("profile_uid = ?", profileUID).
		Delete(&models.NotflixProfileWatchHistory{}).Error
}

// -----------------------------------------------------------------------------
// Per-profile list membership
// -----------------------------------------------------------------------------

func (db *Database) ListNotflixProfileListEntries(profileUID string) ([]*models.NotflixProfileListEntry, error) {
	if profileUID == "" {
		return nil, errors.New("profile uid required")
	}
	var res []*models.NotflixProfileListEntry
	err := db.gormdb.
		Where("profile_uid = ?", profileUID).
		Order("updated_at DESC").
		Find(&res).Error
	if err != nil {
		return nil, err
	}
	return res, nil
}

// UpsertNotflixProfileListEntry inserts or updates the (profile, media) row.
// Used both for "add to list" and "move between lists".
func (db *Database) UpsertNotflixProfileListEntry(item *models.NotflixProfileListEntry) (*models.NotflixProfileListEntry, error) {
	if item == nil {
		return nil, errors.New("item required")
	}
	if item.ProfileUID == "" {
		return nil, errors.New("profile uid required")
	}
	if item.MediaID == 0 {
		return nil, errors.New("media id required")
	}
	if item.Status == "" {
		return nil, errors.New("status required")
	}
	err := db.gormdb.
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "profile_uid"},
				{Name: "media_id"},
			},
			DoUpdates: clause.AssignmentColumns([]string{
				"status",
				"updated_at",
			}),
		}).
		Create(item).Error
	if err != nil {
		return nil, err
	}
	var refreshed models.NotflixProfileListEntry
	if err := db.gormdb.
		Where("profile_uid = ? AND media_id = ?", item.ProfileUID, item.MediaID).
		First(&refreshed).Error; err != nil {
		return nil, err
	}
	return &refreshed, nil
}

func (db *Database) DeleteNotflixProfileListEntry(profileUID string, mediaID int) error {
	return db.gormdb.
		Where("profile_uid = ? AND media_id = ?", profileUID, mediaID).
		Delete(&models.NotflixProfileListEntry{}).Error
}
