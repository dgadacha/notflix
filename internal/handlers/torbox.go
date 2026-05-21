package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"notflix/internal/torbox"

	"github.com/labstack/echo/v4"
)

// TorBox handlers — thin wrappers around internal/torbox/client.
//
// The frontend's play flow:
//
//   1. GET  /api/v1/torbox/status                  (is the key configured?)
//   2. POST /api/v1/torbox/cache  (body: {hashes}) (which torrents are instant?)
//   3. POST /api/v1/torbox/play   (body: {magnet}) (resolves to <video src=…>)

func (h *Handler) HandleTorBoxStatus(c echo.Context) error {
	if !h.App.TorBox.HasKey() {
		return RespondOK(c, map[string]any{"configured": false})
	}
	u, err := h.App.TorBox.Ping(c.Request().Context())
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
	}
	return RespondOK(c, map[string]any{
		"configured":       true,
		"email":            u.Email,
		"plan":             u.Plan,
		"isSubscribed":     u.IsSubscribed,
		"premiumExpiresAt": u.PremiumExpiresAt,
	})
}

func (h *Handler) HandleTorBoxCheckCached(c echo.Context) error {
	var body struct {
		Hashes []string `json:"hashes"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	cached, err := h.App.TorBox.CheckCached(c.Request().Context(), body.Hashes)
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, cached)
}

// HandleTorBoxPlay — POST {"magnet":"magnet:?…","fileId":N (optional)}
//
// Resolves to a streamable URL. Returns immediately when cached. Polls up
// to 3 min when not — the frontend should show a download-progress UI in
// that window.
func (h *Handler) HandleTorBoxPlay(c echo.Context) error {
	var body struct {
		Magnet string `json:"magnet"`
		FileID int    `json:"fileId,omitempty"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	if body.Magnet == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "magnet required"})
	}

	ctx := c.Request().Context()

	// 1) Add the magnet (instant if cached, queued otherwise).
	created, err := h.App.TorBox.AddMagnet(ctx, body.Magnet)
	if err != nil {
		return RespondErr(c, err)
	}

	// 2) Poll until ready — cap at 3 min so the request doesn't hang
	//    forever on non-cached torrents.
	var ready *torbox.Torrent
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		t, err := h.App.TorBox.GetTorrent(ctx, created.TorrentID)
		if err != nil {
			return RespondErr(c, err)
		}
		if t.DownloadFinished || t.DownloadPresent {
			ready = t
			break
		}
		time.Sleep(2 * time.Second)
	}
	if ready == nil {
		return c.JSON(http.StatusGatewayTimeout, map[string]any{
			"error":     "TorBox still downloading after 3 min — retry later",
			"torrentId": created.TorrentID,
		})
	}

	// 3) Pick the file to stream (largest video unless caller overrode).
	fileID := body.FileID
	if fileID == 0 {
		fileID = pickBestVideoFile(ready.Files)
	}

	// 4) Get the streamable URL.
	streamURL, err := h.App.TorBox.RequestDownloadURL(ctx, created.TorrentID, fileID)
	if err != nil {
		return RespondErr(c, err)
	}

	return RespondOK(c, map[string]any{
		"streamUrl":   streamURL,
		"torrentId":   created.TorrentID,
		"fileId":      fileID,
		"torrentName": ready.Name,
		"cached":      ready.Cached,
	})
}

// HandleTorBoxList — for an admin "manage my queue" view.
func (h *Handler) HandleTorBoxList(c echo.Context) error {
	items, err := h.App.TorBox.ListTorrents(c.Request().Context())
	if err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, items)
}

func (h *Handler) HandleTorBoxDelete(c echo.Context) error {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		return RespondErr(c, err)
	}
	if err := h.App.TorBox.DeleteTorrent(c.Request().Context(), id); err != nil {
		return RespondErr(c, err)
	}
	return RespondOK(c, true)
}

// pickBestVideoFile returns the id of the largest video file in the torrent.
// Most torrents have one big movie file + small .nfo/.srt/.txt sidecars;
// "largest video" is a reliable proxy for "the actual movie".
func pickBestVideoFile(files []torbox.TorrentFile) int {
	var bestID int
	var bestSize int64
	for _, f := range files {
		if !isVideoFile(f.Name) {
			continue
		}
		if f.Size > bestSize {
			bestSize = f.Size
			bestID = f.ID
		}
	}
	return bestID
}

func isVideoFile(name string) bool {
	lower := strings.ToLower(name)
	for _, ext := range []string{".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}
