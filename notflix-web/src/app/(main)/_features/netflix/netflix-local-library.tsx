/**
 * "Bibliothèque locale" home rail.
 *
 * Polls /api/v1/local-library — every row was scanned from disk and
 * matched against TMDB. Cards render with the cached TMDB metadata
 * (poster, title, year) and route to /watch?localId=N on click. /watch
 * recognises localId and streams via /api/v1/local-library/stream/:id
 * instead of going through Prowlarr + TorBox.
 *
 * Self-hides when the scan has zero matched rows — keeps the home
 * clean for users who haven't set up a library yet.
 */
import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { ROW } from "@/app/(main)/_features/netflix/netflix.constants"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { useRouter } from "@/lib/navigation"
import { tmdbImage } from "@/lib/tmdb"
import { useQuery } from "@tanstack/react-query"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiPlay } from "react-icons/bi"

export type LocalFile = {
    id: number
    path: string
    sizeBytes: number
    scannedAt: string
    parsedTitle: string
    parsedYear: number
    tmdbId: number
    mediaType: string
    title: string
    posterPath: string
    backdropPath: string
    overview: string
    year: number
}

export function useLocalLibrary() {
    return useQuery<LocalFile[]>({
        queryKey: ["local-library"],
        queryFn: async () => {
            const r = await fetch("/api/v1/local-library")
            if (!r.ok) throw new Error(`local-library ${r.status}`)
            const j = await r.json()
            return (j.data ?? j) as LocalFile[]
        },
        // Re-fetch when the user comes back from /watch — they might
        // have just scanned. Plus a slow 5-min interval to pick up any
        // out-of-band scans.
        refetchOnWindowFocus: true,
        refetchInterval: 5 * 60_000,
        staleTime: 60_000,
    })
}

export function NetflixLocalLibrary() {
    const { t } = useTranslation()
    const { data, isLoading } = useLocalLibrary()

    if (isLoading) {
        return (
            <section className="space-y-3">
                <h2 className={cn("text-xl lg:text-2xl font-bold text-white tracking-tight", ROW.paddingX)}>
                    {t("home.rows.local_library", "Bibliothèque locale")}
                </h2>
                <div className={cn("flex gap-2 overflow-x-auto scrollbar-hide", ROW.paddingX)}>
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="w-72 h-40 rounded-md shrink-0" />
                    ))}
                </div>
            </section>
        )
    }

    if (!data || data.length === 0) return null

    return (
        <section className="space-y-3">
            <h2 className={cn("text-xl lg:text-2xl font-bold text-white tracking-tight flex items-center gap-2", ROW.paddingX)}>
                <span className="size-1.5 rounded-full bg-emerald-400 inline-block" />
                {t("home.rows.local_library", "Bibliothèque locale")}
                <span className="text-[--muted] text-xs font-normal">
                    · {data.length} {t("home.rows.local_library_count_suffix", "fichiers")}
                </span>
            </h2>
            <div
                className={cn(
                    "flex gap-2 overflow-x-auto scrollbar-hide snap-x snap-mandatory",
                    "scroll-pl-6 lg:scroll-pl-16 py-1",
                    ROW.paddingX,
                )}
            >
                {data.map(f => <LocalCard key={f.id} file={f} />)}
            </div>
        </section>
    )
}

function LocalCard({ file }: { file: LocalFile }) {
    const router = useRouter()
    const { openDetail } = useNetflixDetailModal()
    const backdrop = tmdbImage("w780", file.backdropPath) || tmdbImage("w500", file.posterPath)

    const onClickPlay = (e: React.MouseEvent) => {
        e.stopPropagation()
        // Route to /watch with the localId param. The watch page
        // skips Prowlarr + TorBox entirely when this is present.
        router.push(`/watch?localId=${file.id}`)
    }
    const onClickCard = () => {
        // Card click opens the detail modal — same behaviour as
        // every other home rail. The play button is the explicit
        // shortcut to skip the modal.
        if (file.tmdbId > 0) {
            openDetail(file.tmdbId, (file.mediaType as "movie" | "tv") || "movie")
        } else {
            router.push(`/watch?localId=${file.id}`)
        }
    }

    return (
        <button
            type="button"
            onClick={onClickCard}
            className={cn(
                "shrink-0 w-64 sm:w-72 lg:w-80 snap-start text-left group relative",
                "rounded-md overflow-hidden bg-gray-900",
                "transition-transform duration-200 hover:scale-[1.03] hover:z-[2] hover:shadow-2xl",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
            )}
            aria-label={file.title}
        >
            <div className="aspect-video w-full bg-black">
                {backdrop ? (
                    <img
                        src={backdrop}
                        alt={file.title}
                        loading="lazy"
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/40 text-xs p-3 text-center">
                        {file.title || file.parsedTitle}
                    </div>
                )}
            </div>
            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent pointer-events-none">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {file.title || file.parsedTitle}
                </p>
                {file.year > 0 && (
                    <p className="text-white/70 text-xs">{file.year}</p>
                )}
            </div>
            {/* Quick-play button — appears on hover. Pinned bottom-right. */}
            <span
                onClick={onClickPlay}
                role="button"
                aria-label="Play"
                className={cn(
                    "absolute bottom-3 right-3 size-9 rounded-full",
                    "bg-white text-black flex items-center justify-center",
                    "opacity-0 group-hover:opacity-100 transition-opacity",
                    "shadow-lg",
                )}
            >
                <BiPlay className="size-5 ml-0.5" />
            </span>
        </button>
    )
}
