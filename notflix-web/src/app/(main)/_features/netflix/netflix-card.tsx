import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { ROW } from "@/app/(main)/_features/netflix/netflix.constants"
import { prefetchSearchMovie, prefetchSearchTV } from "@/lib/notflix-api"
import { mediaTypeOf, TMDBMedia, tmdbImage, titleOf, yearOf } from "@/lib/tmdb"
import { cn } from "@/components/ui/core/styling"
import { useQueryClient } from "@tanstack/react-query"
import React from "react"

type Props = {
    media: TMDBMedia
    /** Hint loader to fetch eagerly for above-the-fold rows. */
    priority?: boolean
    /**
     * Fixed-width carousel mode (the default) vs grid mode where the card
     * stretches to fill its grid cell.
     */
    variant?: "row" | "grid"
    /** Forced media type when the API didn't include one (TMDB /discover doesn't). */
    fallbackType?: "movie" | "tv"
}

export const NetflixCard = React.memo(function NetflixCard({ media, priority, variant = "row", fallbackType = "movie" }: Props) {
    const { openDetail } = useNetflixDetailModal()
    const qc = useQueryClient()
    const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const type = mediaTypeOf(media, fallbackType)
    // Prefer backdrop (more cinematic 16:9), fall back to poster.
    const img = tmdbImage("w780", media.backdrop_path) || tmdbImage("w500", media.poster_path)
    const title = titleOf(media)
    const year = yearOf(media)

    // Pre-fetch the Prowlarr search after a short hover delay so the
    // result is already in React Query's cache by the time the user
    // clicks Play. 300ms threshold avoids spamming the API when the
    // user just scrolls past a row.
    //
    // For TV, we pre-fetch S01E01 (the default the modal opens on);
    // if they pick a different episode the modal's own fetch takes
    // over — no worse than today.
    const startHoverPrefetch = React.useCallback(() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current)
        hoverTimer.current = setTimeout(() => {
            if (!title) return
            if (type === "movie") {
                prefetchSearchMovie(qc, title, year ? parseInt(year, 10) : undefined)
            } else {
                prefetchSearchTV(qc, title, 1, 1)
            }
        }, 300)
    }, [qc, title, year, type])

    const cancelHoverPrefetch = React.useCallback(() => {
        if (hoverTimer.current) {
            clearTimeout(hoverTimer.current)
            hoverTimer.current = null
        }
    }, [])

    React.useEffect(() => () => cancelHoverPrefetch(), [cancelHoverPrefetch])

    return (
        <a
            href={`/watch?id=${media.id}&type=${type}`}
            aria-label={title}
            onMouseEnter={startHoverPrefetch}
            onMouseLeave={cancelHoverPrefetch}
            onFocus={startHoverPrefetch}
            onBlur={cancelHoverPrefetch}
            onClick={(e) => {
                // Plain left-click → modal (lets the user read the synopsis
                // before committing to the player). Cmd/Ctrl-click, middle-
                // click etc. fall through to the href so power users can
                // open the player straight in a new tab.
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                e.preventDefault()
                openDetail(media.id, type)
            }}
            className={cn(
                "group relative snap-start block cursor-pointer",
                variant === "row" ? cn("flex-none", ROW.cardWidthClass) : "w-full",
                "aspect-video rounded-md overflow-hidden bg-gray-900",
                "ring-0 ring-brand-500 hover:ring-2 transition-[transform,box-shadow,outline] duration-200",
                "hover:scale-[1.03] hover:z-[2] hover:shadow-2xl transform-gpu origin-center",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
            )}
        >
            {img && (
                <img
                    src={img}
                    alt={title}
                    loading={priority ? "eager" : "lazy"}
                    className="absolute inset-0 w-full h-full object-cover object-center"
                />
            )}

            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {title}
                </p>
                <p className="text-gray-300 text-xs mt-0.5 line-clamp-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    {year}
                    {type === "tv" && " · Série"}
                </p>
            </div>
        </a>
    )
})
