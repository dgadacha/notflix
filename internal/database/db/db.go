package db

import (
	"errors"
	"time"

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
		&models.User{},
		&models.Session{},
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

// -----------------------------------------------------------------------------
// Users (auth)
// -----------------------------------------------------------------------------

func (db *Database) ListUsers() ([]*models.User, error) {
	var res []*models.User
	err := db.gormdb.Order("is_admin DESC, created_at ASC").Find(&res).Error
	return res, err
}

func (db *Database) GetUserByUsername(username string) (*models.User, error) {
	if username == "" {
		return nil, errors.New("username required")
	}
	var u models.User
	if err := db.gormdb.Where("username = ?", username).First(&u).Error; err != nil {
		return nil, err
	}
	return &u, nil
}

func (db *Database) GetUserByID(id uint) (*models.User, error) {
	var u models.User
	if err := db.gormdb.First(&u, id).Error; err != nil {
		return nil, err
	}
	return &u, nil
}

func (db *Database) CountUsers() (int64, error) {
	var n int64
	if err := db.gormdb.Model(&models.User{}).Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}

func (db *Database) CreateUser(u *models.User) (*models.User, error) {
	if err := db.gormdb.Create(u).Error; err != nil {
		return nil, err
	}
	return u, nil
}

func (db *Database) UpdateUserPasswordHash(id uint, hash string) error {
	return db.gormdb.Model(&models.User{}).Where("id = ?", id).
		Update("password_hash", hash).Error
}

func (db *Database) DeleteUser(id uint) error {
	return db.gormdb.Transaction(func(tx *gorm.DB) error {
		// Cascade: drop their sessions first so they can't keep using
		// the app between the user delete and the session reaper run.
		if err := tx.Where("user_id = ?", id).Delete(&models.Session{}).Error; err != nil {
			return err
		}
		return tx.Delete(&models.User{}, id).Error
	})
}

// -----------------------------------------------------------------------------
// Sessions (auth)
// -----------------------------------------------------------------------------

func (db *Database) CreateSession(s *models.Session) error {
	return db.gormdb.Create(s).Error
}

func (db *Database) GetSession(token string) (*models.Session, error) {
	if token == "" {
		return nil, errors.New("session token required")
	}
	var s models.Session
	if err := db.gormdb.Where("token = ? AND expires_at > ?", token, time.Now()).First(&s).Error; err != nil {
		return nil, err
	}
	return &s, nil
}

func (db *Database) DeleteSession(token string) error {
	return db.gormdb.Where("token = ?", token).Delete(&models.Session{}).Error
}

func (db *Database) ReapExpiredSessions() error {
	return db.gormdb.Where("expires_at <= ?", time.Now()).Delete(&models.Session{}).Error
}
