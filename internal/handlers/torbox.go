package handlers

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"notflix/internal/torbox"

	"github.com/labstack/echo/v4"
)

// fetchTorrentFromURL downloads a .torrent payload from a Prowlarr-proxied
// indexer URL. Prowlarr either streams the .torrent bytes directly OR
// returns a 30x redirect with Location: magnet:?…  We need to detect that
// redirect case because Go's default http.Client won't follow a non-http
// scheme — but our handler can pass the magnet back instead.
//
// Returns (content, filename, error). When the resolved value is a magnet,
// content holds the magnet URI itself (the caller branches on the prefix).
func fetchTorrentFromURL(ctx context.Context, downloadURL string) ([]byte, string, error) {
	client := &http.Client{
		Timeout: 30 * time.Second,
		// Intercept redirects to non-http schemes (magnet:) since Go won't
		// follow them on its own.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if strings.HasPrefix(req.URL.Scheme, "magnet") {
				return http.ErrUseLastResponse
			}
			if len(via) >= 10 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, "", err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()

	// Handle the magnet-redirect case: 30x with Location: magnet:?…
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		loc := res.Header.Get("Location")
		if strings.HasPrefix(loc, "magnet:") {
			return []byte(loc), "", nil
		}
		return nil, "", echo.NewHTTPError(http.StatusBadGateway,
			"unexpected redirect from indexer: "+loc)
	}

	if res.StatusCode >= 400 {
		return nil, "", echo.NewHTTPError(res.StatusCode, "indexer returned "+res.Status)
	}

	content, err := io.ReadAll(io.LimitReader(res.Body, 25<<20)) // 25 MB cap
	if err != nil {
		return nil, "", err
	}

	filename := guessTorrentFilename(downloadURL, res.Header.Get("Content-Disposition"))
	return content, filename, nil
}

// guessTorrentFilename pulls a sensible name for the upload from either the
// Content-Disposition header or the URL path. TorBox uses it as the torrent
// display name in the user's account.
func guessTorrentFilename(downloadURL, contentDisposition string) string {
	// "attachment; filename=foo.torrent"
	if contentDisposition != "" {
		if idx := strings.Index(contentDisposition, "filename="); idx >= 0 {
			name := strings.Trim(contentDisposition[idx+len("filename="):], `"`)
			if name != "" {
				return name
			}
		}
	}
	u, err := url.Parse(downloadURL)
	if err == nil {
		// Prowlarr puts the release name in the `file` query param.
		if f := u.Query().Get("file"); f != "" {
			if !strings.HasSuffix(strings.ToLower(f), ".torrent") {
				f += ".torrent"
			}
			return f
		}
		if base := path.Base(u.Path); base != "" && base != "/" {
			return base
		}
	}
	return "release.torrent"
}

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

// HandleTorBoxPlay — POST {"magnet":"…"} OR {"downloadUrl":"…"} [+fileId]
//
// Resolves to a streamable URL. Returns immediately when cached. Polls up
// to 3 min when not — the frontend should show a download-progress UI in
// that window.
//
// Two source modes:
//   - magnet     direct magnet URI (works for indexers like 1337x/YTS that
//                expose it natively)
//   - downloadUrl  Prowlarr proxy URL (most other indexers — Torrent9 etc).
//                  The backend fetches the .torrent server-side then forwards
//                  the bytes to TorBox. Server-side fetch is required because
//                  Prowlarr is on a private network TorBox can't reach.
func (h *Handler) HandleTorBoxPlay(c echo.Context) error {
	var body struct {
		Magnet      string `json:"magnet"`
		DownloadURL string `json:"downloadUrl"`
		FileID      int    `json:"fileId,omitempty"`
	}
	if err := c.Bind(&body); err != nil {
		return RespondErr(c, err)
	}
	if body.Magnet == "" && body.DownloadURL == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "magnet or downloadUrl required"})
	}

	ctx := c.Request().Context()

	// 1) Add the torrent (instant if cached, queued otherwise). Try magnet
	//    first, fall back to downloadUrl (fetch .torrent → upload bytes).
	var created *torbox.CreateResult
	var err error
	if body.Magnet != "" {
		created, err = h.App.TorBox.AddMagnet(ctx, body.Magnet)
	} else {
		var content []byte
		var filename string
		content, filename, err = fetchTorrentFromURL(ctx, body.DownloadURL)
		if err != nil {
			return c.JSON(http.StatusBadGateway, map[string]any{
				"error": "failed to fetch .torrent from indexer: " + err.Error(),
			})
		}
		// If the fetch resolved to a magnet (Prowlarr 302 redirect), use the
		// magnet path instead; otherwise upload the binary .torrent.
		if strings.HasPrefix(string(content), "magnet:?") {
			created, err = h.App.TorBox.AddMagnet(ctx, string(content))
		} else {
			created, err = h.App.TorBox.AddTorrentFile(ctx, filename, content)
		}
	}
	if err != nil {
		return RespondErr(c, err)
	}

	// 2) Poll until ready. 90 s cap is tight on purpose: cached
	//    releases reply within 1-3 s, so any wait past ~30 s already
	//    means we're peer-fetching from cold storage. Beyond 90 s
	//    we'd be staring at a "downloading" overlay for minutes —
	//    much better UX is to error out and let the frontend's
	//    fallback machinery try the next ranked release (which the
	//    +1M cached score bonus should ensure is also cached).
	var ready *torbox.Torrent
	deadline := time.Now().Add(90 * time.Second)
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
			"error":     "TorBox: source not cached, peer-fetch > 90s — pick another release",
			"torrentId": created.TorrentID,
		})
	}

	// 3) Pick the file to stream — the largest video file in the torrent.
	//    The caller can override (body.FileID > 0) to pick a specific file.
	//
	//    -1 is the sentinel for "no video file found": we bail explicitly
	//    instead of silently asking TorBox for a zip URL the browser can't
	//    play. Better an error than a corrupt-looking player.
	fileID := -1
	if body.FileID > 0 {
		fileID = body.FileID
	} else if len(ready.Files) > 0 {
		fileID = pickBestVideoFile(ready.Files)
	}
	if fileID < 0 {
		// Surface what TorBox actually listed so the user knows whether
		// the torrent itself is the problem (extras-only release, .iso, …).
		names := make([]string, 0, len(ready.Files))
		for _, f := range ready.Files {
			names = append(names, f.Name)
		}
		log.Printf("torbox: no playable video file in torrent %d (%s); files=%v",
			created.TorrentID, ready.Name, names)
		return c.JSON(http.StatusUnprocessableEntity, map[string]any{
			"error":     "no playable video file in this torrent",
			"torrentId": created.TorrentID,
			"files":     names,
		})
	}

	// 4) Get the streamable URL.
	streamURL, err := h.App.TorBox.RequestDownloadURL(ctx, created.TorrentID, fileID)
	if err != nil {
		return RespondErr(c, err)
	}

	// 5) Single ffprobe call covers everything we need for playback:
	//    duration, audio/video codecs, container format, and subtitles.
	//    The result is passed through to openHLSSession so it doesn't
	//    re-probe (saves 1-2 s on the second hop).
	probe := probeMediaResult(ctx, streamURL)
	durationSec := probe.Duration
	audioCodec := probe.AudioCodec
	embeddedSubs := probe.Subtitles

	// 6) Many anime releases ship subtitles as sidecar files in the
	//    same torrent (.ass / .srt / .vtt). Enumerate them and ask
	//    TorBox for streamable URLs so the player can mount them as
	//    additional <track> elements alongside the embedded ones.
	var externals []externalSub
	for _, f := range ready.Files {
		if !isSubtitleFile(f.Name) {
			continue
		}
		if f.ID == fileID {
			continue // shouldn't happen, but guard against self-ref
		}
		subURL, err := h.App.TorBox.RequestDownloadURL(ctx, created.TorrentID, f.ID)
		if err != nil {
			log.Printf("torbox: skip external sub %q (RequestDownloadURL: %v)", f.Name, err)
			continue
		}
		externals = append(externals, externalSub{
			URL:      subURL,
			Filename: f.Name,
			Language: guessSubLanguageFromFilename(f.Name),
		})
	}
	if len(externals) > 0 {
		log.Printf("torbox: found %d sidecar subtitle files", len(externals))
	}

	// 7) Open the HLS session up-front. Cheap (just metadata + a map
	//    entry) and lets the frontend reference subtitles by sessionId
	//    without first having to round-trip through /stream/hls/start.
	//    If the session can't be opened (probe failure) we still serve
	//    the direct stream — subtitles won't be available, but playback
	//    itself works.
	// Same data-dir capture as the standalone /hls/start path — needed
	// by the chunk-cache reaper that lives in startHLSCleanup.
	hlsCleanupDataDir = h.App.Config.Data.Dir
	var sessionID string
	var allSubs []SubtitleTrack
	if sess, err := openHLSSession(ctx, streamURL, durationSec, audioCodec, embeddedSubs, externals); err == nil {
		sessionID = sess.id
		allSubs = sess.subtitles
		// Prebake the first N source-variant chunks straight from the
		// TorBox URL. `-c copy` so it's cheap (~1 s per chunk) and
		// gives the player an instant-start window without any disk
		// cache of the full source.
		go h.prebakeHLSChunks(sess, hlsPrebakeChunkCount)
	}
	// Sub extraction stays on-demand via /stream/hls/:sessionId/prep,
	// reading the subtitle track directly from the TorBox URL.

	return RespondOK(c, map[string]any{
		"streamUrl":   streamURL,
		"torrentId":   created.TorrentID,
		"fileId":      fileID,
		"torrentName": ready.Name,
		"cached":      ready.Cached,
		"audioCodec":  audioCodec,        // "aac" / "ac3" / "eac3" / "dts" / "truehd" / ""
		"videoCodec":  probe.VideoCodec,  // "h264" / "hevc" / "vp9" / "av1" / "xvid" / ""
		"container":   probe.Container,   // "mov,mp4,m4a,3gp,3g2,mj2" / "matroska,webm" / "avi" / ""
		"durationSec": durationSec,       // 0 on probe failure
		"subtitles":   allSubs,           // embedded + external, with Source field
		"sessionId":   sessionID,         // for subtitle URL construction
	})
}

func isSubtitleFile(name string) bool {
	lower := strings.ToLower(name)
	for _, ext := range []string{".srt", ".ass", ".ssa", ".vtt", ".sub", ".sbv"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// guessSubLanguageFromFilename pulls an ISO-639 language code out of
// common sidecar naming conventions: "show.fr.srt", "show.fre.ass",
// "show.S01E01.French.srt", "show [VOSTFR].ass".
func guessSubLanguageFromFilename(name string) string {
	lower := strings.ToLower(name)
	// Trim the extension so word splits don't anchor on it.
	if dot := strings.LastIndex(lower, "."); dot > 0 {
		lower = lower[:dot]
	}
	candidates := map[string]string{
		// 2-letter ISO-639-1
		"fr": "fre", "en": "eng", "ja": "jpn", "es": "spa", "de": "ger",
		"it": "ita", "pt": "por", "ru": "rus", "ar": "ara", "zh": "chi",
		"ko": "kor", "nl": "nld",
		// 3-letter ISO-639-2
		"fre": "fre", "fra": "fre", "eng": "eng", "jpn": "jpn",
		"spa": "spa", "ger": "ger", "deu": "ger", "ita": "ita",
		"por": "por", "rus": "rus", "ara": "ara", "chi": "chi",
		"zho": "chi", "kor": "kor", "nld": "nld", "dut": "nld",
		// Human names
		"french": "fre", "english": "eng", "japanese": "jpn",
		"spanish": "spa", "german": "ger", "italian": "ita",
		"portuguese": "por", "russian": "rus", "arabic": "ara",
		"chinese": "chi", "korean": "kor", "dutch": "nld",
		// Anime conventions
		"vostfr": "fre", "vffr": "fre", "vff": "fre", "truefrench": "fre",
	}
	parts := strings.FieldsFunc(lower, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'))
	})
	for _, p := range parts {
		if iso, ok := candidates[p]; ok {
			return iso
		}
	}
	return ""
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

// pickBestVideoFile returns the id of the largest video file in the torrent,
// or -1 if no file in the torrent has a recognised video extension.
// Returning a real-but-sentinel-looking 0 was the bug that made the
// previous version request a zip download URL the browser couldn't play.
//
// Most torrents have one big movie file + small .nfo/.srt/.txt sidecars;
// "largest video" is a reliable proxy for "the actual movie".
func pickBestVideoFile(files []torbox.TorrentFile) int {
	bestID := -1
	var bestSize int64 = -1 // -1 so a single zero-size video still wins over nothing
	for _, f := range files {
		if !isVideoFile(f.Name) {
			continue
		}
		if bestID == -1 || f.Size > bestSize {
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
