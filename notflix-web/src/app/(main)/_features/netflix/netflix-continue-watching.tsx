/**
 * "Reprendre la lecture" rail — shown at the top of the home when the
 * active profile has any in-progress watch entries.
 *
 * Pulled directly from the backend (no TMDB roundtrip): the watch
 * history rows already carry the title + poster_path + backdrop_path
 * that were captured at first play. The cards build the TMDB image URL
 * locally so an offline browser still renders a thumbnail.
 *
 * Clicking a card opens /watch with the right season/episode + a `?t=`
 * resume position so the player seeks to where the user left off.
 */
import { ROW } from "@/app/(main)/_features/netflix/netflix.constants"
import { cn } from "@/components/ui/core/styling"
import { useRouter } from "@/lib/navigation"
import {
    ProfileWatchEntry,
    useActiveProfileHistory,
    useActiveProfileId,
} from "@/lib/profiles/profiles"
import { tmdbImage } from "@/lib/tmdb"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiPlay } from "react-icons/bi"

// Ignore entries within FINISHED_THRESHOLD seconds of the end — those
// are "I finished watching" not "I'm partway through".
const FINISHED_THRESHOLD_SEC = 60
// Only show entries above this fraction so 5 seconds of "I tried it"
// doesn't pollute the rail.
const MIN_PROGRESS_FRACTION = 0.02

export function NetflixContinueWatching() {
    const { t } = useTranslation()
    const router = useRouter()
    const profileUid = useActiveProfileId()
    const history = useActiveProfileHistory()

    const inProgress = React.useMemo<ProfileWatchEntry[]>(() => {
        if (!profileUid) return []
        return history
            .filter(h => {
                if (!h.duration || h.duration <= 0) return false
                if (h.currentTime <= 0) return false
                const remaining = h.duration - h.currentTime
                if (remaining <= FINISHED_THRESHOLD_SEC) return false
                if (h.currentTime / h.duration < MIN_PROGRESS_FRACTION) return false
                return true
            })
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .slice(0, 12)
    }, [profileUid, history])

    if (inProgress.length === 0) return null

    const onClick = (e: ProfileWatchEntry) => {
        const params = new URLSearchParams({
            id: String(e.tmdbId),
            type: e.mediaType,
        })
        if (e.mediaType === "tv" && e.season > 0) {
            params.set("season", String(e.season))
            params.set("episode", String(e.episode || 1))
        }
        params.set("t", String(Math.floor(e.currentTime)))
        router.push(`/watch?${params.toString()}`)
    }

    return (
        <section className="space-y-3">
            <h2 className={cn("text-xl lg:text-2xl font-bold text-white tracking-tight", ROW.paddingX)}>
                {t("home.rows.continue_watching", "Reprendre la lecture")}
            </h2>
            <div
                className={cn(
                    "flex gap-2 overflow-x-auto scrollbar-hide snap-x snap-mandatory",
                    "scroll-pl-6 lg:scroll-pl-16",
                    ROW.paddingX,
                    ROW.scrollPaddingY,
                )}
            >
                {inProgress.map(entry => (
                    <ResumeCard
                        key={`${entry.mediaType}-${entry.tmdbId}-${entry.season}-${entry.episode}`}
                        entry={entry}
                        onClick={() => onClick(entry)}
                    />
                ))}
            </div>
        </section>
    )
}

function ResumeCard({ entry, onClick }: { entry: ProfileWatchEntry; onClick: () => void }) {
    const { t } = useTranslation()
    const img =
        tmdbImage("w780", entry.backdropUrl) ||
        tmdbImage("w500", entry.posterPath) ||
        ""
    const progress = entry.duration > 0 ? entry.currentTime / entry.duration : 0
    const remainingMin = Math.max(1, Math.round((entry.duration - entry.currentTime) / 60))

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "group relative snap-start block cursor-pointer text-left",
                "flex-none",
                ROW.cardWidthClass,
                "aspect-video rounded-md overflow-hidden bg-gray-900",
                "ring-0 ring-brand-500 hover:ring-2 transition-[transform,box-shadow,outline] duration-200",
                "hover:scale-[1.03] hover:z-[2] hover:shadow-2xl transform-gpu origin-center",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
            )}
        >
            {img && (
                <img
                    src={img}
                    alt={entry.title}
                    loading="lazy"
                    className="absolute inset-0 w-full h-full object-cover object-center"
                />
            )}

            {/* Progress bar — Netflix puts a thin red strip at the bottom. */}
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                <div
                    className="h-full bg-brand-500"
                    style={{ width: `${Math.min(100, Math.max(2, progress * 100))}%` }}
                />
            </div>

            <div className="absolute inset-x-0 bottom-1 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {entry.title}
                </p>
                <p className="text-gray-300 text-xs mt-0.5 line-clamp-1">
                    {entry.mediaType === "tv" && entry.season > 0
                        ? `S${entry.season}E${entry.episode || 1} · `
                        : ""}
                    {t("home.continue_watching.time_left", "{{m}} min restantes", { m: remainingMin })}
                </p>
            </div>

            {/* Play overlay on hover — desktop affordance. */}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 flex items-center justify-center transition-colors">
                <BiPlay className="size-12 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
        </button>
    )
}
