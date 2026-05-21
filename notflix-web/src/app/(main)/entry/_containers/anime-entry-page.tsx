import { useGetAnilistAnimeDetails } from "@/api/hooks/anilist.hooks"
import { useGetAnimeEntry } from "@/api/hooks/anime_entries.hooks"
import { MediaEntryPageLoadingDisplay } from "@/app/(main)/_features/media/_components/media-entry-page-loading-display"
import { NetflixEpisodeList } from "@/app/(main)/_features/netflix/netflix-episode-list"
import { NetflixMoreLikeThis } from "@/app/(main)/_features/netflix/netflix-more-like-this"
import { PluginWebviewSlot } from "@/app/(main)/_features/plugin/webview/plugin-webviews"
import { MetaSection } from "@/app/(main)/entry/_components/meta-section"
import { PageWrapper } from "@/components/shared/page-wrapper"
import { usePathname, useRouter, useSearchParams } from "@/lib/navigation"
import { atom } from "jotai"
import { useAtom } from "jotai/react"
import React from "react"

// Kept for backwards-compat with components that still read it
// (the modal, the player on /watch). Online streaming is the only
// playback path now, so the value is effectively constant.
export const __anime_entryPageViewAtom = atom<string>("onlinestream")

export function useAnimeEntryPageView() {
    const [currentView, setView] = useAtom(__anime_entryPageViewAtom)
    // Library/torrent/debrid views were dropped; the stubs let legacy
    // call-sites (a few orphan buttons) keep type-checking without doing
    // anything visible.
    const noop = React.useCallback(() => {}, [])
    return {
        currentView,
        setView,
        isLibraryView: currentView === "library",
        isOnlineStreamingView: currentView === "onlinestream",
        isTorrentStreamingView: false,
        isDebridStreamingView: false,
        isPluginEpisodeTabView: currentView.startsWith("episodeTab:"),
        toggleTorrentStreamingView: noop,
        toggleDebridStreamingView: noop,
        toggleOnlineStreamingView: noop,
    }
}

export function AnimeEntryPage() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()
    const mediaId = searchParams.get("id")

    const { data: animeEntry, isLoading: animeEntryLoading } = useGetAnimeEntry(mediaId)
    const { data: animeDetails, isLoading: animeDetailsLoading } = useGetAnilistAnimeDetails(mediaId)

    React.useLayoutEffect(() => {
        if (animeEntry?.media?.title?.userPreferred) {
            document.title = `${animeEntry.media.title.userPreferred} | Notflix`
        }
    }, [animeEntry])

    React.useEffect(() => {
        if (!pathname.startsWith("/entry")) return
        if (!mediaId || (!animeEntryLoading && !animeEntry)) {
            router.push("/")
        }
    }, [animeEntry, animeEntryLoading, pathname, mediaId])

    if (animeEntryLoading || animeDetailsLoading) return <MediaEntryPageLoadingDisplay />
    if (!animeEntry) return null

    return (
        <div data-anime-entry-page>
            <MetaSection entry={animeEntry} details={animeDetails} />

            <div className="px-4 md:px-8 relative z-[8]">
                <PageWrapper className="relative pb-10">
                    <PluginWebviewSlot slot="before-anime-entry-episode-list" />

                    <div className="space-y-8 pt-6">
                        <NetflixEpisodeList animeEntry={animeEntry} />
                        <PluginWebviewSlot slot="after-anime-entry-episode-list" />
                        <NetflixMoreLikeThis details={animeDetails} />
                    </div>

                    <PluginWebviewSlot slot="anime-screen-bottom" />
                </PageWrapper>
            </div>
        </div>
    )
}
