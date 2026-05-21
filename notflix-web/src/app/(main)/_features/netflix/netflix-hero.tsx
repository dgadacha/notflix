import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { HERO } from "@/app/(main)/_features/netflix/netflix.constants"
import { useSlideshow } from "@/app/(main)/_features/netflix/use-slideshow"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { useRouter } from "@/lib/navigation"
import { mediaTypeOf, TMDBMedia, tmdbImage, titleOf, useTrending } from "@/lib/tmdb"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiInfoCircle, BiPlay } from "react-icons/bi"

/**
 * Notflix hero — top-of-home banner that rotates through TMDB weekly
 * trending movies.
 *
 * Resume mode (à la "Reprendre la lecture") is intentionally out of scope here;
 * it'll come back once Phase 3 wires per-profile watch history through the
 * Notflix API.
 */
export function NetflixHero() {
    const { t } = useTranslation()
    const router = useRouter()
    const { openDetail } = useNetflixDetailModal()
    const { data, isLoading } = useTrending("movie", "week")

    const pool = React.useMemo<TMDBMedia[]>(
        () =>
            (data?.results ?? [])
                .filter((m): m is TMDBMedia => !!m && !!m.backdrop_path)
                .slice(0, HERO.poolSize),
        [data],
    )

    const [hovering, setHovering] = React.useState(false)
    const [index, setIndex] = useSlideshow(pool.length, HERO.rotateMs, { paused: hovering })

    if (isLoading || pool.length === 0) {
        return <Skeleton className={cn("w-full rounded-none", HERO.heightClass)} />
    }

    const featured = pool[index] ?? pool[0]
    const type = mediaTypeOf(featured, "movie")
    const title = titleOf(featured)
    const description = featured.overview ?? ""

    return (
        <section
            data-netflix-hero
            className={cn(
                "relative w-full overflow-hidden",
                HERO.heightClass,
            )}
            onMouseEnter={() => setHovering(true)}
            onMouseLeave={() => setHovering(false)}
        >
            <HeroBackdrops pool={pool} activeIndex={index} />
            <HeroGradients />

            <div className="relative z-[2] h-full flex items-end pb-16 sm:pb-20 lg:pb-24 px-4 sm:px-6 lg:px-16">
                <div className="max-w-2xl space-y-3 sm:space-y-4 lg:space-y-5">
                    <h1 className="text-white font-extrabold text-3xl sm:text-4xl lg:text-6xl leading-tight drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
                        {title}
                    </h1>

                    {!!featured.genres?.length && (
                        <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-1 text-xs sm:text-sm text-gray-200">
                            {featured.genres.slice(0, 4).map((g, i) => (
                                <React.Fragment key={g.id}>
                                    {i > 0 && <span className="text-brand-500">•</span>}
                                    <span>{g.name}</span>
                                </React.Fragment>
                            ))}
                        </div>
                    )}

                    {!!description && (
                        <p className="text-sm sm:text-base lg:text-lg text-gray-100/90 line-clamp-3 max-w-xl drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
                            {description}
                        </p>
                    )}

                    <div className="flex items-center gap-2 sm:gap-3 pt-2">
                        <Button
                            size="md"
                            className="bg-white !text-black hover:!bg-white/90 font-bold rounded-md px-4 sm:px-6 lg:px-8 lg:!h-12 lg:!text-base"
                            leftIcon={<BiPlay className="text-xl sm:text-2xl" />}
                            onClick={() => router.push(`/watch?id=${featured.id}&type=${type}`)}
                        >
                            {t("home.hero.play", "Lecture")}
                        </Button>

                        <Button
                            size="md"
                            intent="gray-subtle"
                            className="bg-white/20 hover:bg-white/30 !text-white font-semibold rounded-md px-4 sm:px-6 lg:px-8 lg:!h-12 lg:!text-base backdrop-blur-sm"
                            leftIcon={<BiInfoCircle className="text-xl sm:text-2xl" />}
                            onClick={() => openDetail(featured.id, type)}
                        >
                            {t("home.hero.more_info", "Plus d'infos")}
                        </Button>
                    </div>
                </div>
            </div>

            {pool.length > 1 && (
                <div
                    role="tablist"
                    aria-label="Sélection à la une"
                    className="absolute bottom-4 right-4 sm:bottom-6 sm:right-6 lg:right-16 z-[3] flex items-center gap-1.5"
                >
                    {pool.map((m, i) => (
                        <button
                            key={m.id}
                            role="tab"
                            aria-selected={i === index}
                            aria-label={`Slide ${i + 1}: ${titleOf(m)}`}
                            onClick={() => setIndex(i)}
                            className={cn(
                                "h-1 rounded-full transition-all duration-300",
                                i === index ? "w-8 bg-brand-500" : "w-3 bg-white/30 hover:bg-white/50",
                            )}
                        />
                    ))}
                </div>
            )}
        </section>
    )
}

/**
 * Renders only the active backdrop plus its immediate neighbors (prev + next),
 * so we don't ship 8 high-res banners to the browser when only one is visible.
 * Crossfade still works because neighbors are mounted and ready.
 */
const HeroBackdrops = React.memo(function HeroBackdrops({
    pool,
    activeIndex,
}: {
    pool: TMDBMedia[]
    activeIndex: number
}) {
    const visible = React.useMemo(() => {
        const len = pool.length
        if (len === 0) return new Set<number>()
        if (len === 1) return new Set([0])
        return new Set([
            (activeIndex - 1 + len) % len,
            activeIndex,
            (activeIndex + 1) % len,
        ])
    }, [pool.length, activeIndex])

    return (
        <>
            {pool.map((m, i) => {
                if (!visible.has(i)) return null
                const isActive = i === activeIndex
                const src = tmdbImage("original", m.backdrop_path) || tmdbImage("w780", m.poster_path)
                return (
                    <div
                        key={m.id}
                        className={cn(
                            "absolute inset-0 transition-opacity duration-1000",
                            isActive ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden={!isActive}
                    >
                        {src && (
                            <img
                                src={src}
                                alt={titleOf(m)}
                                loading={isActive ? "eager" : "lazy"}
                                className="absolute inset-0 w-full h-full object-cover object-center"
                            />
                        )}
                    </div>
                )
            })}
        </>
    )
})

const HeroGradients = React.memo(function HeroGradients() {
    return (
        <>
            <div className="absolute inset-x-0 bottom-0 h-[60%] bg-gradient-to-t from-[--background] via-[--background]/80 to-transparent z-[1]" />
            <div className="absolute inset-y-0 left-0 w-[55%] bg-gradient-to-r from-[--background]/95 via-[--background]/60 to-transparent z-[1]" />
            <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/60 to-transparent z-[1]" />
        </>
    )
})
