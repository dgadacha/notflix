package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"notflix/internal/database/models"

	"github.com/labstack/echo/v4"
	"golang.org/x/crypto/bcrypt"
)

// Auth handlers — small surface:
//
//   POST   /api/v1/auth/login   {username, password}     → set cookie
//   POST   /api/v1/auth/logout                            → clear cookie
//   GET    /api/v1/auth/me                                → current user
//   GET    /api/v1/users          (admin)                 → list child accounts
//   POST   /api/v1/users          (admin) {username, password, displayName, isAdmin}
//   DELETE /api/v1/users/:id      (admin)
//   POST   /api/v1/users/:id/password {password} (admin)  → reset child password
//
// Sessions live in SQLite (one row per active session) so the admin
// deleting a child account immediately kicks them out.

const (
	sessionCookieName = "notflix_session"
	sessionTTL        = 30 * 24 * time.Hour
)

func (h *Handler) HandleLogin(c echo.Context) error {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "username + password required"})
	}

	user, err := h.App.Database.GetUserByUsername(body.Username)
	if err != nil {
		// Don't leak "user not found" vs "wrong password" — same response.
		return c.JSON(http.StatusUnauthorized, map[string]any{"error": "invalid credentials"})
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
		return c.JSON(http.StatusUnauthorized, map[string]any{"error": "invalid credentials"})
	}

	token, err := generateSessionToken()
	if err != nil {
		return RespondErr(c, err)
	}
	sess := &models.Session{
		Token:     token,
		UserID:    user.ID,
		ExpiresAt: time.Now().Add(sessionTTL),
		CreatedAt: time.Now(),
	}
	if err := h.App.Database.CreateSession(sess); err != nil {
		return RespondErr(c, err)
	}

	setSessionCookie(c, token, sess.ExpiresAt)
	return RespondOK(c, sanitiseUser(user))
}

func (h *Handler) HandleLogout(c echo.Context) error {
	if cookie, err := c.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		_ = h.App.Database.DeleteSession(cookie.Value)
	}
	clearSessionCookie(c)
	return RespondOK(c, true)
}

func (h *Handler) HandleAuthMe(c echo.Context) error {
	user := UserFromContext(c)
	if user == nil {
		return c.JSON(http.StatusUnauthorized, map[string]any{"error": "not authenticated"})
	}
	return RespondOK(c, sanitiseUser(user))
}

// -----------------------------------------------------------------------------
// Admin: child user management
// -----------------------------------------------------------------------------

func (h *Handler) HandleListUsers(c echo.Context) error {
	users, err := h.App.Database.ListUsers()
	if err != nil {
		return RespondErr(c, err)
	}
	out := make([]map[string]any, 0, len(users))
	for _, u := range users {
		out = append(out, sanitiseUser(u))
	}
	return RespondOK(c, out)
}

func (h *Handler) HandleCreateUser(c echo.Context) error {
	var body struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
		IsAdmin     bool   `json:"isAdmin"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	body.Username = strings.TrimSpace(body.Username)
	if body.Username == "" || body.Password == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "username + password required"})
	}
	if len(body.Password) < 4 {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "password must be at least 4 characters"})
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		return RespondErr(c, err)
	}
	display := body.DisplayName
	if display == "" {
		display = body.Username
	}
	user := &models.User{
		Username:     body.Username,
		PasswordHash: string(hash),
		IsAdmin:      body.IsAdmin,
		DisplayName:  display,
	}
	if _, err := h.App.Database.CreateUser(user); err != nil {
		return c.JSON(http.StatusConflict, map[string]any{
			"error": "could not create user — username already taken?",
		})
	}
	return RespondOK(c, sanitiseUser(user))
}

func (h *Handler) HandleDeleteUser(c echo.Context) error {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid id"})
	}
	target, err := h.App.Database.GetUserByID(uint(id))
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]any{"error": "user not found"})
	}
	// Don't let the admin nuke their own account — they'd lock
	// themselves out and re-bootstrapping requires a server restart.
	if me := UserFromContext(c); me != nil && me.ID == target.ID {
		return c.JSON(http.StatusBadRequest, map[string]any{
			"error": "you can't delete your own admin account",
		})
	}
	if err := h.App.Database.DeleteUser(uint(id)); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}

func (h *Handler) HandleResetUserPassword(c echo.Context) error {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid id"})
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	if len(body.Password) < 4 {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "password must be at least 4 characters"})
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
	if err != nil {
		return RespondErr(c, err)
	}
	if err := h.App.Database.UpdateUserPasswordHash(uint(id), string(hash)); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

func sanitiseUser(u *models.User) map[string]any {
	return map[string]any{
		"id":          u.ID,
		"username":    u.Username,
		"displayName": u.DisplayName,
		"isAdmin":     u.IsAdmin,
		"createdAt":   u.CreatedAt,
	}
}

func generateSessionToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func setSessionCookie(c echo.Context, token string, expires time.Time) {
	cookie := &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// Secure flag is left off so dev (http://localhost) works.
		// In prod behind a Cloudflare Tunnel the connection IS TLS;
		// flip this on when we deploy.
	}
	c.SetCookie(cookie)
}

func clearSessionCookie(c echo.Context) {
	c.SetCookie(&http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

const userContextKey = "notflix-user"

// AuthMiddleware reads the session cookie, looks up the user, and stashes
// them in the echo.Context. Endpoints in `publicEndpoints` are allowed
// through without a session.
func (h *Handler) AuthMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		path := c.Request().URL.Path

		// Wire up `c.Set("user", ...)` for every request so handlers
		// can call UserFromContext without checking nil first when
		// the auth layer didn't actively kick the request.
		if cookie, err := c.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
			if sess, err := h.App.Database.GetSession(cookie.Value); err == nil {
				if u, err := h.App.Database.GetUserByID(sess.UserID); err == nil {
					c.Set(userContextKey, u)
				}
			}
		}

		if isPublicEndpoint(path) {
			return next(c)
		}
		if UserFromContext(c) == nil {
			return c.JSON(http.StatusUnauthorized, map[string]any{"error": "not authenticated"})
		}
		return next(c)
	}
}

// RequireAdmin guards admin-only handlers — 403 when the caller is not.
func (h *Handler) RequireAdmin(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		u := UserFromContext(c)
		if u == nil {
			return c.JSON(http.StatusUnauthorized, map[string]any{"error": "not authenticated"})
		}
		if !u.IsAdmin {
			return c.JSON(http.StatusForbidden, map[string]any{"error": "admin only"})
		}
		return next(c)
	}
}

// Endpoints that don't require a session. Anything else under /api/ is
// gated; the SPA's HTML / static assets are also served by Echo but
// they're outside /api so they're fine — the React side handles the
// "redirect to /login" flow itself.
func isPublicEndpoint(path string) bool {
	publics := []string{
		"/api/v1/status",
		"/api/v1/auth/login",
	}
	for _, p := range publics {
		if path == p {
			return true
		}
	}
	return false
}

// UserFromContext — pull the authenticated user out of the echo context.
// Returns nil for anonymous requests.
func UserFromContext(c echo.Context) *models.User {
	v := c.Get(userContextKey)
	if v == nil {
		return nil
	}
	u, ok := v.(*models.User)
	if !ok {
		return nil
	}
	return u
}
