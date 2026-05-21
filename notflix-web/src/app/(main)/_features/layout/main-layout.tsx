import { ScanProgressBar } from "@/app/(main)/_features/anime-library/_containers/scan-progress-bar"
import { ScannerModal } from "@/app/(main)/_features/anime-library/_containers/scanner-modal"
import { ErrorExplainer } from "@/app/(main)/_features/error-explainer/error-explainer"
import { IssueReport } from "@/app/(main)/_features/issue-report/issue-report"
import { MediaPreviewModal } from "@/app/(main)/_features/media/_containers/media-preview-modal"
import { NetflixBottomTab } from "@/app/(main)/_features/netflix/netflix-bottom-tab"
import { NetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { NetflixTopBar } from "@/app/(main)/_features/netflix/netflix-top-bar"
import { GlobalPlaylistManager } from "@/app/(main)/_features/playlists/_containers/global-playlist-manager"
import { PlaylistListModal } from "@/app/(main)/_features/playlists/playlist-list-modal"
import { PluginManager } from "@/app/(main)/_features/plugin/plugin-manager"
import { PluginWebviewSlot } from "@/app/(main)/_features/plugin/webview/plugin-webviews"
import { ManualProgressTracking } from "@/app/(main)/_features/progress-tracking/manual-progress-tracking"
import { PlaybackManagerProgressTracking } from "@/app/(main)/_features/progress-tracking/playback-manager-progress-tracking"
import { SeaCommand } from "@/app/(main)/_features/sea-command/sea-command"
import { useChangelogTourListener } from "@/app/(main)/_features/tour/changelog-tour.tsx"

import { useAnimeCollectionLoader } from "@/app/(main)/_hooks/anilist-collection-loader"
import { useAnimeLibraryCollectionLoader } from "@/app/(main)/_hooks/anime-library-collection-loader"
import { useMissingEpisodesLoader } from "@/app/(main)/_hooks/missing-episodes-loader"
import { useAnimeCollectionListener } from "@/app/(main)/_listeners/anilist-collection.listeners"
import { useAuthEventListeners } from "@/app/(main)/_listeners/auth.listeners.ts"
import { useExtensionListener } from "@/app/(main)/_listeners/extensions.listeners"
import { useExternalPlayerLinkListener } from "@/app/(main)/_listeners/external-player-link.listeners"
import { useMiscEventListeners } from "@/app/(main)/_listeners/misc-events.listeners"
import { DebridStreamOverlay } from "@/app/(main)/entry/_containers/debrid-stream/debrid-stream-overlay"
import { useTorrentStreamListener } from "@/app/(main)/entry/_containers/torrent-stream/_lib/handle-torrent-stream"
import { TorrentStreamOverlay } from "@/app/(main)/entry/_containers/torrent-stream/torrent-stream-overlay"
import { LoadingOverlayWithLogo } from "@/components/shared/loading-overlay-with-logo"
import { AppLayout, AppLayoutContent, AppSidebarProvider } from "@/components/ui/app-layout"
import { activeProfileIdAtom, useProfilesQuery } from "@/lib/profiles/profiles"
import { usePathname, useRouter } from "@/lib/navigation"
import { __isElectronDesktop__ } from "@/types/constants"
import { useAtomValue } from "jotai"
import React from "react"
import { useServerStatus } from "../../_hooks/use-server-status"
import { useInvalidateQueriesListener } from "../../_listeners/invalidate-queries.listeners"
import { Announcements } from "../announcements"
import { NakamaManager } from "../nakama/nakama-manager"
import { NakamaWatchPartyChat, NakamaWatchPartyChatProvider } from "../nakama/nakama-watch-party-chat"
import { TopIndefiniteLoader } from "../top-indefinite-loader"

const NativePlayerLazyWrapper = React.lazy(() => import("@/app/(main)/_features/native-player/native-player-lazy-wrapper"))

export const MainLayout = ({ children }: { children: React.ReactNode }) => {

    return (
        <>
            <Loader />
            <ScanProgressBar />
            <ScannerModal />
            <PlaylistListModal />
            <GlobalPlaylistManager />
            <TorrentStreamOverlay />
            <DebridStreamOverlay />
            <MediaPreviewModal />
            <NetflixDetailModal />
            <PlaybackManagerProgressTracking />
            <ManualProgressTracking />
            <IssueReport />
            <ErrorExplainer />
            <SeaCommand />

            <PluginManager />
            {(__isElectronDesktop__) && (
                <React.Suspense fallback={null}>
                    <NativePlayerLazyWrapper />
                </React.Suspense>
            )}
            <NakamaManager />
            <NakamaWatchPartyChatProvider />
            <NakamaWatchPartyChat />
            <TopIndefiniteLoader />
            <Announcements />
            <PluginWebviewSlot slot="fixed" />

            <AppSidebarProvider>
                <NetflixTopBar />
                <AppLayout>
                    <AppLayoutContent>
                        {children}
                    </AppLayoutContent>
                </AppLayout>
                <NetflixBottomTab />
            </AppSidebarProvider>
        </>
    )
}

function Loader() {
    useAnimeLibraryCollectionLoader()
    useAnimeCollectionLoader()
    useMissingEpisodesLoader()

    useAnimeCollectionListener()
    useMiscEventListeners()
    useExtensionListener()
    useExternalPlayerLinkListener()
    useInvalidateQueriesListener()
    useTorrentStreamListener()
    useChangelogTourListener()
    useAuthEventListeners()
    useProfileGate()

    const serverStatus = useServerStatus()
    const router = useRouter()
    const pathname = usePathname()

    const [, setHasNavigated] = React.useState(false)
    const prevPathname = React.useRef(pathname)
    React.useEffect(() => {
        if (prevPathname.current !== pathname && pathname !== "/") {
            setHasNavigated(true)
        }
        prevPathname.current = pathname
    }, [pathname])

    React.useEffect(() => {
        if (!serverStatus?.isOffline && pathname.startsWith("/offline")) {
            router.push("/")
        }
    }, [serverStatus?.isOffline, pathname])

    if (serverStatus?.isOffline) {
        return <LoadingOverlayWithLogo />
    }

    return null
}

/**
 * Netflix-style profile gate.
 *
 * Behaviour:
 *   - 0 profiles:  no gating — Notflix works exactly like before (single user).
 *                  The user opts in via the top-bar menu.
 *   - 1+ profiles, none selected:  redirect to /profiles to force a pick.
 *   - 1+ profiles, valid one selected:  pass through.
 *
 * /watch is always allowed (so opening an episode in a new tab doesn't
 * interrupt with a profile picker), and /profiles itself is obviously
 * exempt to avoid a redirect loop.
 */
function useProfileGate() {
    const { profiles, isFetched } = useProfilesQuery()
    const activeId = useAtomValue(activeProfileIdAtom)
    const router = useRouter()
    const pathname = usePathname()

    React.useEffect(() => {
        if (pathname === "/profiles" || pathname.startsWith("/profiles/")) return
        if (pathname.startsWith("/watch")) return
        if (pathname.startsWith("/auth")) return
        if (pathname.startsWith("/offline")) return

        // Wait for the profiles query to have a verdict — without this guard,
        // the gate fires once with profiles=[] (loading) → carve-out → ok,
        // then again with profiles=[N] but a stale activeId snapshot → bounce.
        if (!isFetched) return
        if (profiles.length === 0) return  // user hasn't opted into profiles yet

        // `activeId` is the client-generated UID (string), NOT the SQL auto-id.
        const valid = !!activeId && profiles.some(p => p.uid === activeId)
        if (!valid) router.push("/profiles")
    }, [pathname, profiles, activeId, isFetched])
}
