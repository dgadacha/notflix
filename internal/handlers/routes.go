package handlers

import (
	"errors"
	"net/http"
	"path/filepath"
	"notflix/internal/core"
	util "notflix/internal/util/proxies"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/rs/zerolog"
	"github.com/ziflex/lecho/v3"
)

type Handler struct {
	App *core.App
}

func InitRoutes(app *core.App, e *echo.Echo) {
	h := &Handler{App: app}

	e.Use(h.trustedLocalRequestMiddleware)

	// CORS middleware
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOriginFunc: func(origin string) (bool, error) {
			return isTrustedCORSOrigin(origin, app.Config.Server.Password, app.Config.Server.AccessAllowlist), nil
		},
		AllowHeaders: []string{"Origin", "Content-Type", "Accept", "Cookie", "Authorization",
			"X-Seanime-Token", clientIdHeaderName, clientIdProofHeaderName, clientPlatformHeader,
			"X-Seanime-Nakama-Token", "X-Seanime-Nakama-Username", "X-Seanime-Nakama-Server-Version", "X-Seanime-Nakama-Peer-Id"},
		ExposeHeaders:    []string{clientIdHeaderName, clientIdProofHeaderName},
		AllowCredentials: true,
	}))

	lechoLogger := lecho.From(*app.Logger)

	urisToSkip := []string{
		"/internal/metrics",
		"/_next",
		"/icons",
		"/events",
		"/api/v1/image-proxy",
		"/api/v1/mediastream/transcode/",
		"/api/v1/proxy",
		"/api/v1/directstream/stream",
	}

	// Logging middleware
	e.Use(lecho.Middleware(lecho.Config{
		Logger: lechoLogger,
		Skipper: func(c echo.Context) bool {
			path := c.Request().URL.RequestURI()
			if filepath.Ext(c.Request().URL.Path) == ".txt" ||
				filepath.Ext(c.Request().URL.Path) == ".png" ||
				filepath.Ext(c.Request().URL.Path) == ".ico" {
				return true
			}
			for _, uri := range urisToSkip {
				if uri == path || strings.HasPrefix(path, uri) {
					return true
				}
			}
			return false
		},
		Enricher: func(c echo.Context, logger zerolog.Context) zerolog.Context {
			// Add which file the request came from
			return logger.Str("file", c.Path())
		},
	}))

	// Recovery middleware
	e.Use(middleware.Recover())

	// Client ID middleware
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			req := c.Request()
			cookie, err := c.Cookie(clientIdCookieName)
			clientID := ""
			if err == nil {
				clientID = strings.TrimSpace(cookie.Value)
			}

			if clientID == "" {
				clientID = getClientIdFromRequest(app, req)
			}

			if clientID == "" {
				clientID = uuid.New().String()
			}

			if err != nil || cookie == nil || strings.TrimSpace(cookie.Value) != clientID {
				newCookie := new(http.Cookie)
				newCookie.Name = clientIdCookieName
				newCookie.Value = clientID
				newCookie.HttpOnly = true
				newCookie.Expires = time.Now().Add(24 * time.Hour)
				newCookie.Path = "/"
				newCookie.Domain = ""
				newCookie.SameSite = http.SameSiteLaxMode
				newCookie.Secure = requestUsesTrustedHTTPS(req)

				c.SetCookie(newCookie)
			}

			setClientIdentityHeaders(c.Response().Header(), app, clientID)

			c.Set(clientIdCookieName, clientID)
			c.Set(clientPlatformHeader, getClientPlatformFromRequest(req))

			return next(c)
		}
	})

	e.Use(headMethodMiddleware)
	e.Use(h.controlPlaneBodyLimitMiddleware)
	e.Use(h.controlPlaneMutationRateLimitMiddleware)

	e.GET("/events", h.webSocketEventHandler)

	v1 := e.Group("/api").Group("/v1")

	//
	// Auth middleware
	//
	v1.Use(h.OptionalAuthMiddleware)
	v1.Use(h.FeaturesMiddleware)

	imageProxy := &util.ImageProxy{}
	v1.GET("/image-proxy", imageProxy.ProxyImage)

	v1.GET("/internal/docs", h.HandleGetDocs)

	v1.GET("/proxy", h.VideoProxy)
	v1.HEAD("/proxy", h.VideoProxy)

	v1.GET("/status", h.HandleGetStatus)
	v1.GET("/status/home-items", h.HandleGetHomeItems)
	v1.POST("/status/home-items", h.HandleUpdateHomeItems)

	v1.GET("/log/*", h.HandleGetLogContent)
	v1.GET("/logs/filenames", h.HandleGetLogFilenames)
	v1.DELETE("/logs", h.HandleDeleteLogs)
	v1.GET("/logs/latest", h.HandleGetLatestLogContent)

	v1.GET("/memory/stats", h.HandleGetMemoryStats)
	v1.GET("/memory/profile", h.HandleGetMemoryProfile)
	v1.GET("/memory/goroutine", h.HandleGetGoRoutineProfile)
	v1.GET("/memory/cpu", h.HandleGetCPUProfile)
	v1.POST("/memory/gc", h.HandleForceGC)

	v1.POST("/announcements", h.HandleGetAnnouncements)

	// Auth
	v1.POST("/auth/login", h.HandleLogin)
	v1.POST("/auth/logout", h.HandleLogout)

	// Settings
	v1.GET("/settings", h.HandleGetSettings)
	v1.PATCH("/settings", h.HandleSaveSettings)
	v1.POST("/start", h.HandleGettingStarted)
	v1.PATCH("/settings/auto-downloader", h.HandleSaveAutoDownloaderSettings)
	v1.PATCH("/settings/media-player", h.HandleSaveMediaPlayerSettings)

	// Other
	v1.POST("/test-dump", h.HandleTestDump)

	v1.POST("/directory-selector", h.HandleDirectorySelector)

	v1.POST("/open-in-explorer", h.HandleOpenInExplorer)

	// Translation proxy (DeepL) — key supplied per-request from the client.
	v1.POST("/translate", h.HandleTranslateText)

	v1.POST("/media-player/start", h.HandleStartDefaultMediaPlayer)

	//
	// AniList
	//

	v1Anilist := v1.Group("/anilist")

	v1Anilist.GET("/collection", h.HandleGetAnimeCollection)
	v1Anilist.POST("/collection", h.HandleGetAnimeCollection)

	v1Anilist.GET("/collection/raw", h.HandleGetRawAnimeCollection)
	v1Anilist.POST("/collection/raw", h.HandleGetRawAnimeCollection)
	v1Anilist.GET("/collection/raw/tags", h.HandleGetRawAnimeCollectionTags)

	v1Anilist.GET("/media-details/:id", h.HandleGetAnilistAnimeDetails)

	v1Anilist.GET("/studio-details/:id", h.HandleGetAnilistStudioDetails)

	v1Anilist.POST("/list-entry", h.HandleEditAnilistListEntry)

	v1Anilist.DELETE("/list-entry", h.HandleDeleteAnilistListEntry)

	v1Anilist.POST("/list-anime", h.HandleAnilistListAnime)

	v1Anilist.POST("/list-recent-anime", h.HandleAnilistListRecentAiringAnime)

	v1Anilist.GET("/list-missed-sequels", h.HandleAnilistListMissedSequels)

	v1Anilist.GET("/stats", h.HandleGetAniListStats)

	v1Anilist.GET("/cache-layer/status", h.HandleGetAnilistCacheLayerStatus)

	v1Anilist.POST("/cache-layer/status", h.HandleToggleAnilistCacheLayerStatus)

	//
	// Library
	//

	v1Library := v1.Group("/library")

	v1Library.GET("/collection", h.HandleGetLibraryCollection)
	v1Library.GET("/schedule", h.HandleGetAnimeCollectionSchedule)

	v1Library.GET("/missing-episodes", h.HandleGetMissingEpisodes)
	v1Library.GET("/upcoming-episodes", h.HandleGetUpcomingEpisodes)

	v1Library.GET("/anime-entry/:id", h.HandleGetAnimeEntry)
	v1Library.POST("/anime-entry/suggestions", h.HandleFetchAnimeEntrySuggestions)
	v1Library.POST("/anime-entry/manual-match", h.HandleAnimeEntryManualMatch)
	v1Library.PATCH("/anime-entry/bulk-action", h.HandleAnimeEntryBulkAction)
	v1Library.POST("/anime-entry/open-in-explorer", h.HandleOpenAnimeEntryInExplorer)
	v1Library.POST("/anime-entry/update-progress", h.HandleUpdateAnimeEntryProgress)
	v1Library.POST("/anime-entry/update-repeat", h.HandleUpdateAnimeEntryRepeat)
	v1Library.GET("/anime-entry/silence/:id", h.HandleGetAnimeEntrySilenceStatus)
	v1Library.POST("/anime-entry/silence", h.HandleToggleAnimeEntrySilenceStatus)

	v1Library.POST("/unknown-media", h.HandleAddUnknownMedia)

	//
	// Anime
	//
	v1.GET("/anime/episode-collection/:id", h.HandleGetAnimeEpisodeCollection)

	//
	// Torrent / Torrent Client
	//


	//
	// Updates
	//

	v1.GET("/latest-update", h.HandleGetLatestUpdate)
	v1.GET("/changelog", h.HandleGetChangelog)
	v1.POST("/install-update", h.HandleInstallLatestUpdate)
	v1.POST("/download-release", h.HandleDownloadRelease)
	v1.POST("/check-for-updates", h.HandleCheckForUpdates)

	//
	// Theme
	//

	v1.GET("/theme", h.HandleGetTheme)
	v1.PATCH("/theme", h.HandleUpdateTheme)

	//
	// Playback Manager
	//

	v1.POST("/playback-manager/sync-current-progress", h.HandlePlaybackSyncCurrentProgress)
	v1.POST("/playback-manager/start-playlist", h.HandlePlaybackStartPlaylist)
	v1.POST("/playback-manager/playlist-next", h.HandlePlaybackPlaylistNext)
	v1.POST("/playback-manager/cancel-playlist", h.HandlePlaybackCancelCurrentPlaylist)
	v1.POST("/playback-manager/next-episode", h.HandlePlaybackPlayNextEpisode)
	v1.GET("/playback-manager/next-episode", h.HandlePlaybackGetNextEpisode)
	v1.POST("/playback-manager/autoplay-next-episode", h.HandlePlaybackAutoPlayNextEpisode)
	v1.POST("/playback-manager/play", h.HandlePlaybackPlayVideo)
	v1.POST("/playback-manager/play-random", h.HandlePlaybackPlayRandomVideo)
	//------------
	v1.POST("/playback-manager/manual-tracking/start", h.HandlePlaybackStartManualTracking)
	v1.POST("/playback-manager/manual-tracking/cancel", h.HandlePlaybackCancelManualTracking)

	//
	// Playlists
	//

	v1.GET("/playlists", h.HandleGetPlaylists)
	v1.POST("/playlist", h.HandleCreatePlaylist)
	v1.PATCH("/playlist", h.HandleUpdatePlaylist)
	v1.DELETE("/playlist", h.HandleDeletePlaylist)
	v1.GET("/playlist/episodes/:id", h.HandleGetPlaylistEpisodes)

	//
	// Onlinestream
	//

	v1.POST("/onlinestream/episode-source", h.HandleGetOnlineStreamEpisodeSource)
	v1.POST("/onlinestream/episode-list", h.HandleGetOnlineStreamEpisodeList)
	v1.DELETE("/onlinestream/cache", h.HandleOnlineStreamEmptyCache)

	v1.POST("/onlinestream/search", h.HandleOnlinestreamManualSearch)
	v1.POST("/onlinestream/manual-mapping", h.HandleOnlinestreamManualMapping)
	v1.POST("/onlinestream/get-mapping", h.HandleGetOnlinestreamMapping)
	v1.POST("/onlinestream/remove-mapping", h.HandleRemoveOnlinestreamMapping)

	//
	// Metadata Provider
	//

	v1.POST("/metadata-provider/filler", h.HandlePopulateFillerData)
	v1.DELETE("/metadata-provider/filler", h.HandleRemoveFillerData)
	v1.GET("/metadata/parent/:id", h.HandleGetMediaMetadataParent)
	v1.POST("/metadata/parent", h.HandleSaveMediaMetadataParent)
	v1.DELETE("/metadata/parent", h.HandleDeleteMediaMetadataParent)

	//
	// File Cache
	//

	v1FileCache := v1.Group("/filecache")
	v1FileCache.GET("/total-size", h.HandleGetFileCacheTotalSize)
	v1FileCache.DELETE("/bucket", h.HandleRemoveFileCacheBucket)
	v1FileCache.GET("/mediastream/videofiles/total-size", h.HandleGetFileCacheMediastreamVideoFilesTotalSize)
	v1FileCache.DELETE("/mediastream/videofiles", h.HandleClearFileCacheMediastreamVideoFiles)

	//
	// Discord
	//

	v1Discord := v1.Group("/discord")
	v1Discord.POST("/presence/legacy-anime", h.HandleSetDiscordLegacyAnimeActivity)
	v1Discord.POST("/presence/anime", h.HandleSetDiscordAnimeActivityWithProgress)
	v1Discord.POST("/presence/anime-update", h.HandleUpdateDiscordAnimeActivityWithProgress)
	v1Discord.POST("/presence/cancel", h.HandleCancelDiscordActivity)

	//
	// Media Stream
	//
	v1.GET("/mediastream/settings", h.HandleGetMediastreamSettings)
	v1.PATCH("/mediastream/settings", h.HandleSaveMediastreamSettings)
	v1.POST("/mediastream/request", h.HandleRequestMediastreamMediaContainer)
	v1.POST("/mediastream/preload", h.HandlePreloadMediastreamMediaContainer)
	// Transcode
	v1.POST("/mediastream/shutdown-transcode", h.HandleMediastreamShutdownTranscodeStream)
	v1.GET("/mediastream/transcode/*", h.HandleMediastreamTranscode)
	v1.GET("/mediastream/subs/*", h.HandleMediastreamGetSubtitles)
	v1.GET("/mediastream/att/*", h.HandleMediastreamGetAttachments)
	v1.GET("/mediastream/direct", h.HandleMediastreamDirectPlay)
	v1.HEAD("/mediastream/direct", h.HandleMediastreamDirectPlay)
	v1.GET("/mediastream/file", h.HandleMediastreamFile)

	//
	// Direct Stream
	//
	v1.POST("/directstream/play/localfile", h.HandleDirectstreamPlayLocalFile)
	v1.GET("/directstream/stream", echo.WrapHandler(h.HandleDirectstreamGetStream()))
	v1.HEAD("/directstream/stream", echo.WrapHandler(h.HandleDirectstreamGetStream()))
	v1.GET("/directstream/att/*", h.HandleDirectstreamGetAttachments)
	v1.POST("/directstream/subs/convert-subs", h.HandleDirectstreamConvertSubs)

	//
	// VideoCore
	//
	v1.GET("/videocore/insight/character/:malId", h.HandleVideoCoreInSightGetCharacterDetails)

	//
	// Extensions
	//

	v1Extensions := v1.Group("/extensions")
	v1Extensions.POST("/playground/run", h.HandleRunExtensionPlaygroundCode)
	v1Extensions.POST("/external/fetch", h.HandleFetchExternalExtensionData)
	v1Extensions.POST("/external/install", h.HandleInstallExternalExtension)
	v1Extensions.POST("/external/install-repository", h.HandleInstallExternalExtensionRepository)
	v1Extensions.POST("/external/uninstall", h.HandleUninstallExternalExtension)
	v1Extensions.POST("/external/edit-payload", h.HandleUpdateExtensionCode)
	v1Extensions.POST("/external/reload", h.HandleReloadExternalExtensions)
	v1Extensions.POST("/external/reload", h.HandleReloadExternalExtension)
	v1Extensions.POST("/all", h.HandleGetAllExtensions)
	v1Extensions.GET("/updates", h.HandleGetExtensionUpdateData)
	v1Extensions.GET("/list", h.HandleListExtensionData)
	v1Extensions.GET("/payload/:id", h.HandleGetExtensionPayload)
	v1Extensions.GET("/list/development", h.HandleListDevelopmentModeExtensions)
	v1Extensions.GET("/list/manga-provider", h.HandleListMangaProviderExtensions)
	v1Extensions.GET("/list/onlinestream-provider", h.HandleListOnlinestreamProviderExtensions)
	v1Extensions.GET("/list/custom-source", h.HandleListCustomSourceExtensions)
	v1Extensions.GET("/user-config/:id", h.HandleGetExtensionUserConfig)
	v1Extensions.POST("/user-config", h.HandleSaveExtensionUserConfig)
	v1Extensions.GET("/marketplace", h.HandleGetMarketplaceExtensions)
	v1Extensions.GET("/plugin-settings", h.HandleGetPluginSettings)
	v1Extensions.POST("/plugin-settings/pinned-trays", h.HandleSetPluginSettingsPinnedTrays)
	v1Extensions.POST("/plugin-permissions/grant", h.HandleGrantPluginPermissions)

	//
	// Continuity
	//
	v1Continuity := v1.Group("/continuity")
	v1Continuity.PATCH("/item", h.HandleUpdateContinuityWatchHistoryItem)
	v1Continuity.GET("/item/:id", h.HandleGetContinuityWatchHistoryItem)
	v1Continuity.GET("/history", h.HandleGetContinuityWatchHistory)

	//
	// Notflix: Netflix-style profiles + per-profile watch history.
	// All client-managed (the frontend generates the uid), the server is just
	// the persistence layer.
	//
	v1NotflixProfiles := v1.Group("/notflix-profiles")
	v1NotflixProfiles.GET("", h.HandleListNotflixProfiles)
	v1NotflixProfiles.POST("", h.HandleCreateNotflixProfile)
	v1NotflixProfiles.PATCH("/:uid", h.HandleUpdateNotflixProfile)
	v1NotflixProfiles.DELETE("/:uid", h.HandleDeleteNotflixProfile)
	v1NotflixProfiles.GET("/:uid/history", h.HandleListNotflixProfileHistory)
	v1NotflixProfiles.PUT("/:uid/history", h.HandleUpsertNotflixProfileHistoryItem)
	v1NotflixProfiles.POST("/:uid/history", h.HandleUpsertNotflixProfileHistoryItemPOST) // sendBeacon
	v1NotflixProfiles.DELETE("/:uid/history", h.HandleClearNotflixProfileHistory)
	v1NotflixProfiles.DELETE("/:uid/history/:mediaId", h.HandleDeleteNotflixProfileHistoryItem)
	v1NotflixProfiles.DELETE("/:uid/history/:mediaId/episode/:episodeNumber", h.HandleDeleteNotflixProfileHistoryEpisode)
	// Per-profile list (each profile sees its own "Mes listes" view, on top
	// of the shared AniList account that still tracks progress globally)
	v1NotflixProfiles.GET("/:uid/list", h.HandleListNotflixProfileList)
	v1NotflixProfiles.PUT("/:uid/list", h.HandleUpsertNotflixProfileListEntry)
	v1NotflixProfiles.DELETE("/:uid/list/:mediaId", h.HandleDeleteNotflixProfileListEntry)

	//
	// Sync
	//
	v1Local := v1.Group("/local")
	v1Local.GET("/track", h.HandleLocalGetTrackedMediaItems)
	v1Local.POST("/track", h.HandleLocalAddTrackedMedia)
	v1Local.DELETE("/track", h.HandleLocalRemoveTrackedMedia)
	v1Local.GET("/track/:id/:type", h.HandleLocalGetIsMediaTracked)
	v1Local.POST("/local", h.HandleLocalSyncData)
	v1Local.GET("/queue", h.HandleLocalGetSyncQueueState)
	v1Local.POST("/anilist", h.HandleLocalSyncAnilistData)
	v1Local.POST("/updated", h.HandleLocalSetHasLocalChanges)
	v1Local.GET("/updated", h.HandleLocalGetHasLocalChanges)
	v1Local.GET("/storage/size", h.HandleLocalGetLocalStorageSize)
	v1Local.POST("/sync-simulated-to-anilist", h.HandleLocalSyncSimulatedDataToAnilist)

	v1Local.POST("/offline", h.HandleSetOfflineMode)

	//
	// Report
	//

	v1.POST("/report/issue", h.HandleSaveIssueReport)
	v1.GET("/report/issue/download", h.HandleDownloadIssueReport)
	v1.POST("/report/issue/decompress", h.HandleDecompressIssueReport)

	//
	// Nakama
	//

	v1Nakama := v1.Group("/nakama")
	v1Nakama.GET("/ws", h.HandleNakamaWebSocket)
	v1Nakama.POST("/message", h.HandleSendNakamaMessage)
	v1Nakama.POST("/reconnect", h.HandleNakamaReconnectToHost)
	v1Nakama.POST("/cleanup", h.HandleNakamaRemoveStaleConnections)
	v1Nakama.GET("/room/available", h.HandleNakamaRoomsAvailable)
	v1Nakama.POST("/room/create", h.HandleNakamaCreateAndJoinRoom)
	v1Nakama.POST("/room/disconnect", h.HandleNakamaDisconnectFromRoom)
	v1Nakama.GET("/host/anime/library", h.HandleGetNakamaAnimeLibrary)
	v1Nakama.GET("/host/anime/library/shared", h.HandleGetNakamaAnimeLibraryShared)
	v1Nakama.GET("/host/anime/library/files/:id", h.HandleGetNakamaAnimeLibraryFiles)
	v1Nakama.GET("/host/anime/library/files", h.HandleGetNakamaAnimeAllLibraryFiles)
	v1Nakama.POST("/play", h.HandleNakamaPlayVideo)
	v1Nakama.GET("/host/anime/library/stream", h.HandleNakamaHostAnimeLibraryServeStream)
	v1Nakama.HEAD("/host/anime/library/stream", h.HandleNakamaHostAnimeLibraryServeStream)
	v1Nakama.GET("/stream", h.HandleNakamaProxyStream)
	v1Nakama.HEAD("/stream", h.HandleNakamaProxyStream)
	v1Nakama.POST("/watch-party/create", h.HandleNakamaCreateWatchParty)
	v1Nakama.POST("/watch-party/join", h.HandleNakamaJoinWatchParty)
	v1Nakama.POST("/watch-party/leave", h.HandleNakamaLeaveWatchParty)
	v1Nakama.POST("/watch-party/chat", h.HandleNakamaSendChatMessage)

	//
	// Custom Source
	//
	v1CustomSource := v1.Group("/custom-source")
	v1CustomSource.POST("/provider/list/anime", h.HandleCustomSourceListAnime)
	v1CustomSource.POST("/provider/list/manga", h.HandleCustomSourceListManga)

}

func (h *Handler) JSON(c echo.Context, code int, i interface{}) error {
	return c.JSON(code, i)
}

func (h *Handler) RespondWithData(c echo.Context, data interface{}) error {
	return c.JSON(200, NewDataResponse(data))
}

func (h *Handler) RespondWithError(c echo.Context, err error) error {
	return c.JSON(statusCodeForError(err), NewErrorResponse(err))
}

func (h *Handler) RespondWithStatusError(c echo.Context, code int, err error) error {
	return c.JSON(code, NewErrorResponse(err))
}

func statusCodeForError(err error) int {
	if err == nil {
		return http.StatusInternalServerError
	}

	if echoErr, ok := errors.AsType[*echo.HTTPError](err); ok && echoErr.Code >= 400 && echoErr.Code < 600 {
		return echoErr.Code
	}

	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		return http.StatusRequestEntityTooLarge
	}

	if strings.EqualFold(strings.TrimSpace(err.Error()), "UNAUTHENTICATED") {
		return http.StatusUnauthorized
	}

	return http.StatusInternalServerError
}

func headMethodMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		// Skip stream routes
		if strings.Contains(c.Request().URL.Path, "/directstream/stream") ||
			strings.Contains(c.Request().URL.Path, "/nakama") {
			return next(c)
		}

		if c.Request().Method == http.MethodHead {
			// Set the method to GET temporarily to reuse the handler
			c.Request().Method = http.MethodGet

			defer func() {
				c.Request().Method = http.MethodHead
			}() // Restore method after

			// Call the next handler and then clear the response body
			if err := next(c); err != nil {
				if err.Error() == echo.ErrMethodNotAllowed.Error() {
					return c.NoContent(http.StatusOK)
				}

				return err
			}
		}

		return next(c)
	}
}
