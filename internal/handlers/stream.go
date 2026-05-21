package handlers

import (
	"io"
	"log"
	"net/http"
	"net/url"
	"os/exec"
	"strings"

	"github.com/labstack/echo/v4"
)

// HandleStreamTransmux — GET /api/v1/stream/transmux?url=<torbox-url>
//
// Pipes a TorBox URL through ffmpeg, re-encoding ONLY the audio track to
// AAC stereo while copying the video stream verbatim. Used as a fallback
// when the browser can't decode the source audio (Dolby Digital Plus,
// DTS, TrueHD on Chrome Linux/Windows).
//
// Trade-offs vs. direct playback:
//   - bandwidth doubled (Notflix downloads from TorBox + uploads to the
//     client at the same time)
//   - no seek backward (pipe is one-way)
//   - ~1-2s startup latency (ffmpeg opens the source, finds codecs)
//   - ~1-5% CPU for the AAC encode (on M1; negligible)
//
// Only the TorBox CDN is whitelisted to prevent the server being abused
// as an open proxy for arbitrary URLs.
func (h *Handler) HandleStreamTransmux(c echo.Context) error {
	raw := c.QueryParam("url")
	if raw == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "url required"})
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return c.JSON(http.StatusBadRequest, map[string]any{"error": "invalid url"})
	}
	if !isAllowedStreamHost(u.Host) {
		return c.JSON(http.StatusForbidden, map[string]any{
			"error": "host not allowed for transmux: " + u.Host,
		})
	}

	// Tie ffmpeg lifetime to the request — if the client navigates away
	// or the network drops, the context cancels and ffmpeg exits.
	ctx := c.Request().Context()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "warning",
		"-i", raw,
		"-c:v", "copy", // remux video stream, no re-encode
		"-c:a", "aac", // re-encode audio to AAC (universally compatible)
		"-b:a", "192k",
		"-ac", "2", // downmix to stereo (covers all browsers, fits headphones)
		"-f", "matroska",
		// "pipe:1" tells ffmpeg to write to stdout. Matroska is much
		// friendlier than mp4 for live progressive playback because
		// it doesn't need a global moov atom at the end of the file.
		"pipe:1",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return RespondErr(c, err)
	}
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return c.JSON(http.StatusBadGateway, map[string]any{
			"error": "ffmpeg failed to start: " + err.Error(),
		})
	}

	// Pump ffmpeg's stderr to the server log. Helpful for diagnosing
	// codec mismatches; doesn't impact throughput.
	go func() {
		buf := make([]byte, 1024)
		for {
			n, rerr := stderr.Read(buf)
			if n > 0 {
				log.Printf("ffmpeg: %s", strings.TrimSpace(string(buf[:n])))
			}
			if rerr != nil {
				return
			}
		}
	}()

	c.Response().Header().Set("Content-Type", "video/x-matroska")
	c.Response().Header().Set("Cache-Control", "no-store")
	c.Response().Header().Set("Accept-Ranges", "none") // pipe = no backward seek
	c.Response().WriteHeader(http.StatusOK)

	// io.Copy returns when the client disconnects (write error) or when
	// ffmpeg finishes. We must Wait() afterwards to reap the process.
	_, copyErr := io.Copy(c.Response().Writer, stdout)
	waitErr := cmd.Wait()
	if copyErr != nil && copyErr != io.EOF {
		log.Printf("transmux: copy error: %v", copyErr)
	}
	if waitErr != nil {
		log.Printf("transmux: ffmpeg exit: %v", waitErr)
	}
	return nil
}

// isAllowedStreamHost — whitelist for the transmux source URL. Without
// this the endpoint would happily proxy any arbitrary remote URL,
// effectively turning the backend into an open ffmpeg-as-a-service.
//
// TorBox CDN hosts seen in the wild — all variants must be covered:
//
//	store-043.wnam.tb-cdn.io       (older "store" cluster)
//	nexus-163.weur.tb-cdn.st       (newer "nexus" cluster, .st TLD)
//	*.tb-cdn.com                   (defensive — observed in dashboards)
//	torrents.torbox.app            (account-level direct hosting)
func isAllowedStreamHost(host string) bool {
	h := strings.ToLower(host)
	for _, suffix := range []string{
		".tb-cdn.io",
		".tb-cdn.st",
		".tb-cdn.com",
		".torbox.app",
	} {
		if strings.HasSuffix(h, suffix) {
			return true
		}
	}
	return false
}
