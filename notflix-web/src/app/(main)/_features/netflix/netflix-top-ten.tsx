/**
 * "Top 10 cette semaine" row — Netflix's signature row, with a giant
 * 1-10 numeral sitting behind each card.
 *
 * Source: TMDB /trending/all/week — combines movies + series ranked by
 * the previous 7 days of TMDB activity (views, searches, ratings).
 * Refreshed every Monday from upstream. Truncated to the top 10.
 *
 * Visual identity: portrait posters (NOT the 16:9 backdrops the rest of
 * the home uses) so each card has the vertical real estate a numeral
 * needs to feel composed alongside it. The number is rendered with a
 * thick white outline + transparent fill so it reads as a "ghost"
 * watermark rather than competing with the poster for attention.
 */
import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { ROW } from "@/app/(main)/_features/netflix/netflix.constants"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { mediaTypeOf, TMDBMedia, tmdbImage, titleOf } from "@/lib/tmdb"
import { useQuery } from "@tanstack/react-query"
import React from "react"
import { useTranslation } from "react-i18next"

function useTop10ThisWeek() {
    return useQuery<{ results: TMDBMedia[] }>({
        queryKey: ["tmdb", "trending", "all", "week"],
        queryFn: async () => {
            const r = await fetch("/api/v1/tmdb/trending/all/week")
            if (!r.ok) throw new Error(`tmdb ${r.status}`)
            return r.json()
        },
        // TMDB refreshes trending once a day; 6 h cache is plenty.
        staleTime: 6 * 60 * 60_000,
    })
}

export function NetflixTopTen() {
    const { t } = useTranslation()
    const { data, isLoading } = useTop10ThisWeek()
    const items = (data?.results ?? []).slice(0, 10)

    if (!isLoading && items.length === 0) return null

    return (
        <section className="space-y-3">
            <h2 className={cn("text-xl lg:text-2xl font-bold text-white tracking-tight", ROW.paddingX)}>
                {t("home.rows.top_10_week", "Top 10 cette semaine")}
            </h2>
            <div
                className={cn(
                    // The numeral extends past the card on the left, so we
                    // need extra pl-6 + scroll-pl-12 to make the first one
                    // start in-frame.
                    "flex gap-3 overflow-x-auto scrollbar-hide snap-x snap-mandatory",
                    "scroll-pl-6 lg:scroll-pl-16 pb-2",
                    ROW.paddingX,
                )}
            >
                {isLoading
                    ? Array.from({ length: 10 }).map((_, i) => <TopTenSkeleton key={i} />)
                    : items.map((item, i) => <TopTenCard key={`${item.media_type}-${item.id}`} rank={i + 1} media={item} />)
                }
            </div>
        </section>
    )
}

function TopTenCard({ rank, media }: { rank: number; media: TMDBMedia }) {
    const { openDetail } = useNetflixDetailModal()
    const type = mediaTypeOf(media, "movie")
    // Use the portrait poster — Netflix's Top 10 style is poster-shaped
    // regardless of source.
    const img = tmdbImage("w500", media.poster_path) || tmdbImage("w780", media.backdrop_path)
    const title = titleOf(media)

    return (
        <button
            type="button"
            onClick={() => openDetail(media.id, type)}
            className={cn(
                "shrink-0 relative flex items-end snap-start",
                "h-44 sm:h-52 lg:h-60 group",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 rounded-md",
            )}
            aria-label={`${rank}. ${title}`}
        >
            {/* Ghost numeral. 10 is two digits → needs a wider track than
                1-9. We sneak in a narrower font-stretch + tighter
                letter-spacing for that one to avoid blowing the layout. */}
            <span
                className={cn(
                    "font-black leading-none text-transparent select-none",
                    "text-[7rem] sm:text-[9rem] lg:text-[11rem]",
                    rank === 10 ? "tracking-tighter" : "",
                )}
                style={{
                    WebkitTextStroke: "2.5px rgba(255,255,255,0.55)",
                    fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
                }}
                aria-hidden
            >
                {rank}
            </span>

            {/* Poster overlapping the numeral on the right edge */}
            <div
                className={cn(
                    "relative shrink-0 -ml-4 sm:-ml-6",
                    "w-24 sm:w-28 lg:w-32 aspect-[2/3] rounded-md overflow-hidden",
                    "bg-white/5 border border-white/10",
                    "shadow-[0_8px_24px_rgba(0,0,0,0.6)]",
                    "transition-transform duration-200 group-hover:scale-[1.04]",
                )}
            >
                {img ? (
                    <img
                        src={img}
                        alt={title}
                        loading="lazy"
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-white/40 p-2 text-center">
                        {title}
                    </div>
                )}
            </div>
        </button>
    )
}

function TopTenSkeleton() {
    return (
        <div className="shrink-0 relative flex items-end h-44 sm:h-52 lg:h-60">
            <span className="font-black text-[7rem] sm:text-[9rem] lg:text-[11rem] leading-none text-white/5">
                ?
            </span>
            <Skeleton className="w-24 sm:w-28 lg:w-32 aspect-[2/3] rounded-md -ml-4 sm:-ml-6" />
        </div>
    )
}
