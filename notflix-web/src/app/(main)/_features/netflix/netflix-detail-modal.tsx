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
import { useRouter } from "@/lib/navigation"
import {
    AUDIO_OPTIONS,
    QUALITY_OPTIONS,
    useAudioPref,
    useQualityPref,
} from "@/lib/preferences"
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
    const router = useRouter()
    const { closeDetail } = useNetflixDetailModal()
    const { data, isLoading } = useTMDBDetail(target.type, target.id)
    const [quality, setQuality] = useQualityPref()
    const [audio, setAudio] = useAudioPref()

    if (isLoading || !data) return <BodySkeleton />

    const type = mediaTypeOf(data, target.type)
    const banner = tmdbImage("original", data.backdrop_path) || tmdbImage("w780", data.poster_path)
    const title = titleOf(data)
    const year = yearOf(data)
    const overview = data.overview || ""
    const genres = data.genres?.map(g => g.name) ?? []
    const score = data.vote_average

    // Navigate in the same tab + close the modal. Pass the user's quality /
    // audio prefs down as query params — /watch filters the Prowlarr release
    // list with them before the auto-pick runs.
    const onPlay = () => {
        const params = new URLSearchParams({ id: String(data.id), type })
        if (quality !== "auto") params.set("quality", quality)
        if (audio !== "auto") params.set("audio", audio)
        closeDetail()
        router.push(`/watch?${params.toString()}`)
    }

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
                        <Button
                            size="md"
                            onClick={onPlay}
                            className="bg-white !text-black hover:!bg-white/90 font-bold rounded-md px-6 lg:px-8 lg:!h-12 lg:!text-base"
                            leftIcon={<BiPlay className="text-xl sm:text-2xl" />}
                        >
                            {t("modal.play", "Lecture")}
                        </Button>

                        {/* Quality + audio prefs — persisted in localStorage so
                            the choice survives between films. /watch reads
                            them from the URL params. */}
                        <PrefSelect
                            label={t("modal.quality", "Qualité")}
                            value={quality}
                            options={QUALITY_OPTIONS}
                            onChange={(v) => setQuality(v as typeof quality)}
                        />
                        <PrefSelect
                            label={t("modal.audio", "Langue")}
                            value={audio}
                            options={AUDIO_OPTIONS}
                            onChange={(v) => setAudio(v as typeof audio)}
                        />
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

/**
 * Compact label-on-top dropdown styled to sit next to the white Lecture
 * button. We use a native <select> + overlay rather than a Radix component
 * to keep the modal a11y story simple and the bundle lean.
 */
function PrefSelect<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string
    value: T
    options: { value: T; label: string }[]
    onChange: (v: T) => void
}) {
    const current = options.find(o => o.value === value)
    return (
        <label className="relative inline-flex flex-col gap-0.5 text-left">
            <span className="text-[10px] uppercase tracking-wider text-[--muted] font-semibold">
                {label}
            </span>
            <span
                className={cn(
                    "inline-flex items-center justify-between gap-2 min-w-[10rem]",
                    "bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded-md",
                    "px-3 py-2 text-white text-sm font-semibold",
                    "transition-colors",
                )}
            >
                {current?.label ?? value}
                <svg className="size-4 opacity-70" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
            </span>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value as T)}
                className="absolute inset-0 opacity-0 cursor-pointer"
                aria-label={label}
            >
                {options.map(o => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </label>
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
