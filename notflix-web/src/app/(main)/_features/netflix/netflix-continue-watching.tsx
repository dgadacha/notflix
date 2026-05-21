import { useGetAnimeCollection } from "@/api/hooks/anilist.hooks"
import { useGetAnimeEntry } from "@/api/hooks/anime_entries.hooks"
import { useGetContinuityWatchHistory } from "@/api/hooks/continuity.hooks"
import { ROW } from "@/app/(main)/_features/netflix/netflix.constants"
import { NetflixRowShell } from "@/app/(main)/_features/netflix/netflix-row"
import { ProfileWatchEntry, useActiveProfileHistory, useActiveProfileId } from "@/lib/profiles/profiles"
import { SeaImage } from "@/components/shared/sea-image"
import { cn } from "@/components/ui/core/styling"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiPlay } from "react-icons/bi"

// Hide an entry once the user is within FINISHED_THRESHOLD seconds of the end —
// assume they've finished and don't want it cluttering the row.
const FINISHED_THRESHOLD = 60

type HistoryItem = {
    mediaId: number
    episodeNumber: number
    currentTime: number
    duration: number
    progress: number
    timeUpdated: number
}

/**
 * Source of truth for the row:
 *   - If a profile is active, read the server-backed per-profile history
 *     (`/api/v1/notflix-profiles/:uid/history` — the saver on /watch upserts every
 *     5s + on tab close).
 *   - Otherwise (user hasn't opted into profiles yet), fall back to seanime's
 *     legacy `/api/v1/continuity/history` so single-user mode keeps working.
 */
function useContinueWatchingItems(): HistoryItem[] {
    const profileId = useActiveProfileId()
    const profileHistory: ProfileWatchEntry[] = useActiveProfileHistory()
    const { data: backendHistory } = useGetContinuityWatchHistory()

    return React.useMemo<HistoryItem[]>(() => {
        // Profile mode: server returns an array sorted by updated_at desc.
        if (profileId) {
            return profileHistory
                .filter(h => h && h.duration > 0 && h.currentTime > 0
                    && h.currentTime < h.duration - FINISHED_THRESHOLD)
                .map(h => ({
                    mediaId: h.mediaId,
                    episodeNumber: h.episodeNumber,
                    currentTime: h.currentTime,
                    duration: h.duration,
                    progress: Math.max(0, Math.min(1, h.currentTime / h.duration)),
                    timeUpdated: h.updatedAt ? new Date(h.updatedAt).getTime() : 0,
                } as HistoryItem))
                .sort((a, b) => b.timeUpdated - a.timeUpdated)
        }

        // Legacy single-user mode: continuity returns a map keyed by mediaId.
        return Object.values(backendHistory ?? {})
            .filter((h: any) => h && h.duration > 0 && h.currentTime > 0
                && h.currentTime < h.duration - FINISHED_THRESHOLD)
            .map((h: any) => ({
                mediaId: h.mediaId,
                episodeNumber: h.episodeNumber,
                currentTime: h.currentTime,
                duration: h.duration,
                progress: Math.max(0, Math.min(1, h.currentTime / h.duration)),
                timeUpdated: h.timeUpdated ? new Date(h.timeUpdated).getTime() : 0,
            } as HistoryItem))
            .sort((a, b) => b.timeUpdated - a.timeUpdated)
    }, [profileId, profileHistory, backendHistory])
}

export function NetflixContinueWatching() {
    const { t } = useTranslation()
    const items = useContinueWatchingItems()

    if (items.length === 0) return null

    return (
        <NetflixRowShell title={t("home.rows.continue_watching")}>
            {items.map(item => <ResumeCard key={item.mediaId} item={item} />)}
        </NetflixRowShell>
    )
}

function ResumeCard({ item }: { item: HistoryItem }) {
    const { t } = useTranslation()
    const { mediaId, episodeNumber, currentTime, progress } = item

    // Look in the AniList collection first (free — already loaded). Only hit
    // the per-entry endpoint if the user hasn't added this anime to a list yet.
    const { data: collection } = useGetAnimeCollection()
    const fromCollection = React.useMemo(() => {
        if (!collection) return null
        for (const list of collection.MediaListCollection?.lists ?? []) {
            for (const entry of list?.entries ?? []) {
                if (entry?.media?.id === mediaId) return entry.media
            }
        }
        return null
    }, [collection, mediaId])

    const { data: entry } = useGetAnimeEntry(fromCollection ? null : mediaId)
    const media = fromCollection ?? entry?.media ?? null

    const img = media?.bannerImage || media?.coverImage?.extraLarge || media?.coverImage?.large || ""
    const title = media?.title?.userPreferred || ""

    // Round to nearest second so the URL stays stable across re-renders.
    const resumeTime = Math.floor(currentTime)
    const watchHref = `/watch?id=${mediaId}&episode=${episodeNumber}&t=${resumeTime}`

    return (
        <a
            href={watchHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${t("home.hero.play")} – ${title} – ${t("entry.episode_short")} ${episodeNumber}`}
            className={cn(
                "group relative snap-start flex-none block",
                ROW.cardWidthClass,
                "aspect-video rounded-md overflow-hidden bg-gray-900",
                "ring-0 ring-brand-500 hover:ring-2 transition-[transform,box-shadow,outline] duration-200",
                "hover:scale-[1.03] hover:z-[2] hover:shadow-2xl transform-gpu origin-center",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
            )}
        >
            {img && (
                <SeaImage src={img} alt={title} fill priority className="object-cover object-center" />
            )}

            <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="size-14 rounded-full bg-white/90 flex items-center justify-center text-black shadow-lg">
                    <BiPlay className="text-3xl translate-x-0.5" />
                </span>
            </div>

            <div className="absolute inset-x-0 bottom-0 p-3 pb-4 bg-gradient-to-t from-black/95 via-black/60 to-transparent space-y-1.5">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {title || `#${mediaId}`}
                </p>
                <p className="text-gray-300 text-xs">
                    {t("entry.episode_short")} {episodeNumber}
                </p>
                <div className="h-1 bg-white/20 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-500" style={{ width: `${progress * 100}%` }} />
                </div>
            </div>
        </a>
    )
}
