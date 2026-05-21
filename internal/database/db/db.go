package db

import (
	"errors"

	"notflix/internal/database/models"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

type Database struct {
	gormdb *gorm.DB
}

func Open(path string) (*Database, error) {
	g, err := gorm.Open(sqlite.Open(path+"?_journal_mode=WAL&_foreign_keys=on"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, err
	}
	if err := g.AutoMigrate(
		&models.Profile{},
		&models.ProfileWatchHistory{},
		&models.ProfileListEntry{},
	); err != nil {
		return nil, err
	}
	return &Database{gormdb: g}, nil
}

func (db *Database) Close() error {
	sqlDB, err := db.gormdb.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// -----------------------------------------------------------------------------
// Profile CRUD
// -----------------------------------------------------------------------------

func (db *Database) ListProfiles() ([]*models.Profile, error) {
	var res []*models.Profile
	err := db.gormdb.Order("created_at ASC").Find(&res).Error
	return res, err
}

func (db *Database) GetProfile(uid string) (*models.Profile, error) {
	if uid == "" {
		return nil, errors.New("profile uid required")
	}
	var p models.Profile
	if err := db.gormdb.Where("uid = ?", uid).First(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

func (db *Database) CreateProfile(p *models.Profile) (*models.Profile, error) {
	if err := db.gormdb.Create(p).Error; err != nil {
		return nil, err
	}
	return p, nil
}

func (db *Database) UpdateProfile(uid, name, avatar, color string) (*models.Profile, error) {
	p, err := db.GetProfile(uid)
	if err != nil {
		return nil, err
	}
	updates := map[string]any{}
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
	return db.GetProfile(uid)
}

func (db *Database) DeleteProfile(uid string) error {
	return db.gormdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("profile_uid = ?", uid).Delete(&models.ProfileWatchHistory{}).Error; err != nil {
			return err
		}
		if err := tx.Where("profile_uid = ?", uid).Delete(&models.ProfileListEntry{}).Error; err != nil {
			return err
		}
		return tx.Where("uid = ?", uid).Delete(&models.Profile{}).Error
	})
}

// -----------------------------------------------------------------------------
// Watch history (per profile)
// -----------------------------------------------------------------------------

func (db *Database) ListWatchHistory(profileUID string) ([]*models.ProfileWatchHistory, error) {
	var res []*models.ProfileWatchHistory
	err := db.gormdb.Where("profile_uid = ?", profileUID).Order("updated_at DESC").Find(&res).Error
	return res, err
}

func (db *Database) UpsertWatchHistory(item *models.ProfileWatchHistory) (*models.ProfileWatchHistory, error) {
	err := db.gormdb.
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "profile_uid"}, {Name: "tmdb_id"}, {Name: "media_type"},
				{Name: "season"}, {Name: "episode"},
			},
			DoUpdates: clause.AssignmentColumns([]string{
				"current_time", "duration",
				"title", "poster_path", "backdrop_url",
				"release_name", "release_source", "release_info_hash",
				"updated_at",
			}),
		}).
		Create(item).Error
	if err != nil {
		return nil, err
	}
	var refreshed models.ProfileWatchHistory
	if err := db.gormdb.
		Where("profile_uid = ? AND tmdb_id = ? AND media_type = ? AND season = ? AND episode = ?",
			item.ProfileUID, item.TMDBID, item.MediaType, item.Season, item.Episode).
		First(&refreshed).Error; err != nil {
		return nil, err
	}
	return &refreshed, nil
}

func (db *Database) DeleteWatchHistoryByMedia(profileUID string, tmdbID int, mediaType string) error {
	return db.gormdb.
		Where("profile_uid = ? AND tmdb_id = ? AND media_type = ?", profileUID, tmdbID, mediaType).
		Delete(&models.ProfileWatchHistory{}).Error
}

func (db *Database) ClearWatchHistory(profileUID string) error {
	return db.gormdb.Where("profile_uid = ?", profileUID).Delete(&models.ProfileWatchHistory{}).Error
}

// -----------------------------------------------------------------------------
// Profile list (per-profile "Mes listes")
// -----------------------------------------------------------------------------

func (db *Database) ListProfileList(profileUID string) ([]*models.ProfileListEntry, error) {
	var res []*models.ProfileListEntry
	err := db.gormdb.Where("profile_uid = ?", profileUID).Order("updated_at DESC").Find(&res).Error
	return res, err
}

func (db *Database) UpsertProfileList(item *models.ProfileListEntry) (*models.ProfileListEntry, error) {
	err := db.gormdb.
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "profile_uid"}, {Name: "tmdb_id"}, {Name: "media_type"},
			},
			DoUpdates: clause.AssignmentColumns([]string{
				"status", "title", "poster_path", "updated_at",
			}),
		}).
		Create(item).Error
	if err != nil {
		return nil, err
	}
	var refreshed models.ProfileListEntry
	if err := db.gormdb.
		Where("profile_uid = ? AND tmdb_id = ? AND media_type = ?", item.ProfileUID, item.TMDBID, item.MediaType).
		First(&refreshed).Error; err != nil {
		return nil, err
	}
	return &refreshed, nil
}

func (db *Database) DeleteProfileListEntry(profileUID string, tmdbID int, mediaType string) error {
	return db.gormdb.
		Where("profile_uid = ? AND tmdb_id = ? AND media_type = ?", profileUID, tmdbID, mediaType).
		Delete(&models.ProfileListEntry{}).Error
}
