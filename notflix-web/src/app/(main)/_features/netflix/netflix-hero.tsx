import { AL_BaseAnime } from "@/api/generated/types"
import { useGetAnimeCollection } from "@/api/hooks/anilist.hooks"
import { useGetAnimeEntry } from "@/api/hooks/anime_entries.hooks"
import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { HERO } from "@/app/(main)/_features/netflix/netflix.constants"
import { useSlideshow } from "@/app/(main)/_features/netflix/use-slideshow"
import { useDiscoverTrendingAnime } from "@/app/(main)/discover/_lib/handle-discover-queries"
import { useActiveProfileHistory, useActiveProfileId } from "@/lib/profiles/profiles"
import { SeaImage } from "@/components/shared/sea-image"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { useTranslatedText } from "@/lib/translate/use-translated-text"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiInfoCircle, BiPlay } from "react-icons/bi"

// Ignore entries within FINISHED_THRESHOLD seconds of the end for the resume
// hero — those are "I finished watching" not "I left in the middle".
const RESUME_FINISHED_THRESHOLD = 60

export function NetflixHero() {
    const { t } = useTranslation()
    const { openDetail } = useNetflixDetailModal()
    const { data, isLoading } = useDiscoverTrendingAnime()

    const pool = React.useMemo<AL_BaseAnime[]>(
        () =>
            (data?.Page?.media ?? [])
                .filter((m): m is AL_BaseAnime => !!m && !!m.bannerImage && m.status !== "NOT_YET_RELEASED")
                .slice(0, HERO.poolSize),
        [data],
    )

    const [hovering, setHovering] = React.useState(false)
    const [index, setIndex] = useSlideshow(pool.length, HERO.rotateMs, { paused: hovering })

    // Resume detection — when the active profile has an in-progress episode,
    // the hero swaps from trending-slideshow to a single-card "Reprendre"
    // pinned to that anime. More useful than a random highlight.
    const profileId = useActiveProfileId()
    const profileHistory = useActiveProfileHistory()
    const resume = React.useMemo(() => {
        if (!profileId) return null
        const inProgress = profileHistory
            .filter(h => h.duration > 0 && h.currentTime > 0 && h.currentTime < h.duration - RESUME_FINISHED_THRESHOLD)
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        return inProgress[0] ?? null
    }, [profileId, profileHistory])

    // Resolve the resume anime's full media payload — try the AniList cache
    // first (cheap), fall back to the per-entry endpoint when missing.
    const { data: collection } = useGetAnimeCollection()
    const resumeMediaFromCollection = React.useMemo(() => {
        if (!resume || !collection) return null
        for (const list of collection.MediaListCollection?.lists ?? []) {
            for (const entry of list?.entries ?? []) {
                if (entry?.media?.id === resume.mediaId) return entry.media as AL_BaseAnime
            }
        }
        return null
    }, [resume, collection])
    const { data: resumeEntry } = useGetAnimeEntry(resume && !resumeMediaFromCollection ? resume.mediaId : null)
    const resumeMedia = resumeMediaFromCollection ?? (resumeEntry?.media as AL_BaseAnime | undefined) ?? null

    // Either resume mode or slideshow mode — never both. featured is always
    // a single media object so the rest of the JSX stays unchanged.
    const inResumeMode = !!(resume && resumeMedia?.bannerImage)
    const featured = inResumeMode ? resumeMedia! : (pool[index] ?? pool[0])

    // Hooks must run unconditionally — keep them above the loading early-return.
    const rawDescription = featured?.description?.replace(/(<([^>]+)>)/gi, "") || ""
    const { text: description } = useTranslatedText(rawDescription)

    if (isLoading || (!inResumeMode && pool.length === 0)) {
        return <Skeleton className={cn("w-full rounded-none", HERO.heightClass)} />
    }

    const resumeHref = resume
        ? `/watch?id=${resume.mediaId}&episode=${resume.episodeNumber}&t=${Math.floor(resume.currentTime)}`
        : null

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
            {inResumeMode ? (
                // Single-card resume mode: a static backdrop, no slideshow churn.
                <div className="absolute inset-0">
                    <SeaImage
                        src={resumeMedia.bannerImage || resumeMedia.coverImage?.extraLarge || ""}
                        alt={resumeMedia.title?.userPreferred || ""}
                        fill
                        priority
                        className="object-cover object-center"
                    />
                </div>
            ) : (
                <HeroBackdrops pool={pool} activeIndex={index} />
            )}
            <HeroGradients />

            <div className="relative z-[2] h-full flex items-end pb-16 sm:pb-20 lg:pb-24 px-4 sm:px-6 lg:px-16">
                <div className="max-w-2xl space-y-3 sm:space-y-4 lg:space-y-5">
                    <h1 className="text-white font-extrabold text-3xl sm:text-4xl lg:text-6xl leading-tight drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
                        {featured.title?.userPreferred}
                    </h1>

                    {!!featured.genres?.length && (
                        <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-1 text-xs sm:text-sm text-gray-200">
                            {featured.genres.slice(0, 4).map((g, i) => (
                                <React.Fragment key={g}>
                                    {i > 0 && <span className="text-brand-500">•</span>}
                                    <span>{g}</span>
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
                        {inResumeMode && resumeHref ? (
                            <a href={resumeHref} target="_blank" rel="noopener noreferrer" className="inline-flex">
                                <Button
                                    size="md"
                                    className="bg-white !text-black hover:!bg-white/90 font-bold rounded-md px-4 sm:px-6 lg:px-8 lg:!h-12 lg:!text-base"
                                    leftIcon={<BiPlay className="text-xl sm:text-2xl" />}
                                >
                                    {t("home.hero.resume")} {t("entry.episode_short")} {resume!.episodeNumber}
                                </Button>
                            </a>
                        ) : (
                            <Button
                                size="md"
                                className="bg-white !text-black hover:!bg-white/90 font-bold rounded-md px-4 sm:px-6 lg:px-8 lg:!h-12 lg:!text-base"
                                leftIcon={<BiPlay className="text-xl sm:text-2xl" />}
                                onClick={() => openDetail(featured.id)}
                            >
                                {t("home.hero.play")}
                            </Button>
                        )}

                        <Button
                            size="md"
                            intent="gray-subtle"
                            className="bg-white/20 hover:bg-white/30 !text-white font-semibold rounded-md px-4 sm:px-6 lg:px-8 lg:!h-12 lg:!text-base backdrop-blur-sm"
                            leftIcon={<BiInfoCircle className="text-xl sm:text-2xl" />}
                            onClick={() => openDetail(featured.id)}
                        >
                            {t("home.hero.more_info")}
                        </Button>
                    </div>
                </div>
            </div>

            {!inResumeMode && pool.length > 1 && (
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
                            aria-label={`Slide ${i + 1}: ${m.title?.userPreferred ?? ""}`}
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
    pool: AL_BaseAnime[]
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
                return (
                    <div
                        key={m.id}
                        className={cn(
                            "absolute inset-0 transition-opacity duration-1000",
                            isActive ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden={!isActive}
                    >
                        <SeaImage
                            src={m.bannerImage || m.coverImage?.extraLarge || ""}
                            alt={m.title?.userPreferred || ""}
                            fill
                            priority={isActive}
                            className="object-cover object-center"
                        />
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
