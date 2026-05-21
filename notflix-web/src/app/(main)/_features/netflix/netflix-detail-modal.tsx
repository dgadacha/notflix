/**
 * Notflix detail modal — opens when a card is clicked from the home / lists
 * / search grid. Shows TMDB metadata (poster, overview, year, genres, rating)
 * and routes to /watch via a primary CTA.
 *
 * The full version (Prowlarr release picker preview, "more like this" rail)
 * will land in Phase 3e. This stub is the minimum viable surface so the
 * cards can open something and the hero's Play / More info buttons have a
 * target.
 */
import { Button, IconButton } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Modal } from "@/components/ui/modal"
import { Skeleton } from "@/components/ui/skeleton"
import { mediaTypeOf, titleOf, tmdbImage, useTMDBDetail, yearOf } from "@/lib/tmdb"
import { atom, useAtom, useSetAtom } from "jotai"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiInfoCircle, BiPlay, BiX } from "react-icons/bi"

type ModalTarget = { id: number; type: "movie" | "tv" } | null

const __notflixDetailModalAtom = atom<ModalTarget>(null)

export function useNetflixDetailModal() {
    const set = useSetAtom(__notflixDetailModalAtom)
    return {
        openDetail: (mediaId: number, mediaType: "movie" | "tv" = "movie") =>
            set({ id: mediaId, type: mediaType }),
        closeDetail: () => set(null),
    }
}

export function NetflixDetailModal() {
    const [target, setTarget] = useAtom(__notflixDetailModalAtom)
    const open = target !== null

    return (
        <Modal
            open={open}
            onOpenChange={(v) => { if (!v) setTarget(null) }}
            // Bump above the fixed top bar (z-[60]); on mobile the navbar
            // avatar otherwise sits where the close button belongs.
            overlayClass="!z-[70]"
            contentClass="!max-w-5xl !p-0 !rounded-xl overflow-hidden bg-[#0a0a0a] border-white/5"
            hideCloseButton
        >
            {open && (
                <>
                    <IconButton
                        intent="gray-subtle"
                        size="md"
                        className={cn(
                            "absolute z-[80] rounded-full bg-black/80 hover:bg-black !text-white",
                            "right-3 top-3",
                            "size-11 lg:size-9",
                        )}
                        icon={<BiX className="text-2xl" />}
                        onClick={() => setTarget(null)}
                        aria-label="Close"
                    />
                    <Body target={target!} />
                </>
            )}
        </Modal>
    )
}

function Body({ target }: { target: { id: number; type: "movie" | "tv" } }) {
    const { t } = useTranslation()
    const { data, isLoading } = useTMDBDetail(target.type, target.id)

    if (isLoading || !data) return <BodySkeleton />

    const type = mediaTypeOf(data, target.type)
    const banner = tmdbImage("original", data.backdrop_path) || tmdbImage("w780", data.poster_path)
    const title = titleOf(data)
    const year = yearOf(data)
    const overview = data.overview || ""
    const genres = data.genres?.map(g => g.name) ?? []
    const score = data.vote_average
    const watchHref = `/watch?id=${data.id}&type=${type}`

    return (
        <div className="max-h-[90vh] sm:max-h-[85vh] overflow-y-auto">
            {/* Hero — taller on mobile to fit title + CTA without squeezing
                into a 200px strip. */}
            <div className="relative w-full aspect-[4/3] sm:aspect-[16/9] lg:aspect-[16/8] bg-black">
                {banner && (
                    <img
                        src={banner}
                        alt={title}
                        className="absolute inset-0 w-full h-full object-cover object-center"
                    />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/30 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6 lg:p-10 space-y-3 lg:space-y-4">
                    <h1 className="text-2xl sm:text-3xl lg:text-5xl font-extrabold text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)] max-w-2xl leading-tight">
                        {title}
                    </h1>
                    <div className="flex items-center gap-3 flex-wrap">
                        <a href={watchHref} target="_blank" rel="noopener noreferrer" className="inline-flex">
                            <Button
                                size="md"
                                className="bg-white !text-black hover:!bg-white/90 font-bold rounded-md px-6 lg:px-8 lg:!h-12 lg:!text-base"
                                leftIcon={<BiPlay className="text-xl sm:text-2xl" />}
                            >
                                {t("modal.play", "Lecture")}
                            </Button>
                        </a>
                        <Button
                            size="md"
                            intent="gray-subtle"
                            className="bg-white/20 hover:bg-white/30 !text-white font-semibold rounded-md px-4 lg:px-6 lg:!h-12 lg:!text-base backdrop-blur-sm"
                            leftIcon={<BiInfoCircle className="text-xl sm:text-2xl" />}
                            disabled
                        >
                            {t("modal.more_info", "Plus d'infos")}
                        </Button>
                    </div>
                </div>
            </div>

            {/* Body */}
            <div className="p-4 sm:p-6 lg:p-10 space-y-6 lg:space-y-8">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
                    <div className="lg:col-span-2 space-y-3">
                        <div className="flex items-center gap-3 flex-wrap text-sm text-[--muted]">
                            {year && <span className="text-white">{year}</span>}
                            {type === "tv" && data.number_of_seasons != null && (
                                <span>
                                    {data.number_of_seasons} {t("modal.seasons", "saisons")}
                                </span>
                            )}
                            {type === "movie" && data.runtime != null && (
                                <span>{data.runtime} min</span>
                            )}
                            {score != null && score > 0 && (
                                <span className="px-2 py-0.5 rounded bg-brand-500/20 text-brand-300 font-semibold text-xs">
                                    {score.toFixed(1)}/10
                                </span>
                            )}
                        </div>
                        <p className="text-gray-200 leading-relaxed text-sm lg:text-base">
                            {overview}
                        </p>
                    </div>
                    <div className="space-y-2 text-sm">
                        {genres.length > 0 && (
                            <div>
                                <span className="text-[--muted]">{t("modal.genres", "Genres")}: </span>
                                <span className="text-white">{genres.join(", ")}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

function BodySkeleton() {
    return (
        <div className="space-y-6">
            <Skeleton className="w-full aspect-[16/8] rounded-none" />
            <div className="px-10 pb-10 space-y-3">
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-3/4" />
            </div>
        </div>
    )
}
