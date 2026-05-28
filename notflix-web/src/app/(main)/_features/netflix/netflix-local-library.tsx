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
    season: number
    episode: number
}

// A LibraryEntry is what we actually render on the rail. For movies
// it's a 1-to-1 wrap around a LocalFile. For TV shows, we group every
// episode that shares a tmdbId into ONE entry — `firstEpisode` is the
// chronologically-earliest one (S01E01 if available), used as the
// click-to-play target, and `episodeCount` shows on the card badge.
type LibraryEntry = {
    key: string
    mediaType: "movie" | "tv"
    tmdbId: number
    title: string
    backdropPath: string
    posterPath: string
    year: number
    firstFile: LocalFile
    episodeCount: number // 1 for movies, N for shows
    parsedTitle: string
}

/** Groups raw LocalFile rows into rail-ready entries. TV episodes
 *  collapse to one entry per show; movies stay 1-to-1. Returns the
 *  list sorted by most-recently-scanned first (so "I just added X"
 *  surfaces at the front). */
function buildEntries(files: LocalFile[]): LibraryEntry[] {
    type Acc = {
        key: string
        mediaType: "movie" | "tv"
        tmdbId: number
        title: string
        backdropPath: string
        posterPath: string
        year: number
        files: LocalFile[]
        parsedTitle: string
        latestScannedAt: number
    }
    const byKey = new Map<string, Acc>()
    for (const f of files) {
        const mt = (f.mediaType === "tv" ? "tv" : "movie") as "movie" | "tv"
        // TV groups by show; movies stay per-file (each file = its own
        // entry, even when tmdbId matches another row — different rips
        // of the same film get one card each, the user can pick).
        const key = mt === "tv" && f.tmdbId > 0
            ? `tv-${f.tmdbId}`
            : `mv-${f.id}`
        const existing = byKey.get(key)
        const scannedAt = new Date(f.scannedAt).getTime()
        if (!existing) {
            byKey.set(key, {
                key,
                mediaType: mt,
                tmdbId: f.tmdbId,
                title: f.title || f.parsedTitle,
                backdropPath: f.backdropPath,
                posterPath: f.posterPath,
                year: f.year || f.parsedYear,
                files: [f],
                parsedTitle: f.parsedTitle,
                latestScannedAt: scannedAt,
            })
            continue
        }
        existing.files.push(f)
        if (scannedAt > existing.latestScannedAt) {
            existing.latestScannedAt = scannedAt
        }
    }

    // Materialise + sort the episodes inside each TV group so
    // firstFile is the chronologically-earliest (S01E01 first, then
    // by id as a tiebreaker for "season 0 specials" which sort badly
    // otherwise).
    const out: LibraryEntry[] = []
    for (const acc of byKey.values()) {
        acc.files.sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season
            if (a.episode !== b.episode) return a.episode - b.episode
            return a.id - b.id
        })
        out.push({
            key: acc.key,
            mediaType: acc.mediaType,
            tmdbId: acc.tmdbId,
            title: acc.title,
            backdropPath: acc.backdropPath,
            posterPath: acc.posterPath,
            year: acc.year,
            firstFile: acc.files[0],
            episodeCount: acc.files.length,
            parsedTitle: acc.parsedTitle,
        })
    }
    // Most-recently-scanned groups first.
    out.sort((a, b) => {
        const ad = new Date(a.firstFile.scannedAt).getTime()
        const bd = new Date(b.firstFile.scannedAt).getTime()
        return bd - ad
    })
    return out
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

    const entries = React.useMemo(() => buildEntries(data ?? []), [data])

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

    if (entries.length === 0) return null

    // Count display: shows "12 titres · 47 fichiers" so the user sees
    // both the de-duped card count and the raw file count.
    const fileCount = (data ?? []).length

    return (
        <section className="space-y-3">
            <h2 className={cn("text-xl lg:text-2xl font-bold text-white tracking-tight flex items-center gap-2", ROW.paddingX)}>
                <span className="size-1.5 rounded-full bg-emerald-400 inline-block" />
                {t("home.rows.local_library", "Bibliothèque locale")}
                <span className="text-[--muted] text-xs font-normal">
                    {entries.length === fileCount
                        ? `· ${fileCount} ${t("home.rows.local_library_files", "fichiers")}`
                        : `· ${entries.length} ${t("home.rows.local_library_titles", "titres")} (${fileCount} ${t("home.rows.local_library_files", "fichiers")})`}
                </span>
            </h2>
            <div
                className={cn(
                    "flex gap-2 overflow-x-auto scrollbar-hide snap-x snap-mandatory",
                    "scroll-pl-6 lg:scroll-pl-16 py-1",
                    ROW.paddingX,
                )}
            >
                {entries.map(entry => <LocalCard key={entry.key} entry={entry} />)}
            </div>
        </section>
    )
}

function LocalCard({ entry }: { entry: LibraryEntry }) {
    const router = useRouter()
    const { t } = useTranslation()
    const { openDetail } = useNetflixDetailModal()
    const backdrop = tmdbImage("w780", entry.backdropPath) || tmdbImage("w500", entry.posterPath)
    const file = entry.firstFile

    const onClickPlay = (e: React.MouseEvent) => {
        e.stopPropagation()
        // TV → plays the first episode (S01E01 typically). User can
        // pick a different one from inside the modal later if we wire
        // the episode picker.
        router.push(`/watch?localId=${file.id}`)
    }
    const onClickCard = () => {
        if (entry.tmdbId > 0) {
            openDetail(entry.tmdbId, entry.mediaType)
        } else {
            router.push(`/watch?localId=${file.id}`)
        }
    }
    const isTV = entry.mediaType === "tv"

    const displayTitle = entry.title || entry.parsedTitle

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
            aria-label={displayTitle}
        >
            <div className="aspect-video w-full bg-black">
                {backdrop ? (
                    <img
                        src={backdrop}
                        alt={displayTitle}
                        loading="lazy"
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-white/40 text-xs p-3 text-center">
                        {displayTitle}
                    </div>
                )}
            </div>
            {/* Top-left chip for TV shows — "12 ép." badge. Lets the
                user see at a glance that a card represents a season
                pack vs a single film. */}
            {isTV && entry.episodeCount > 0 && (
                <span className={cn(
                    "absolute top-2 left-2 px-1.5 py-0.5 rounded",
                    "bg-black/70 backdrop-blur-sm border border-white/15",
                    "text-[10px] font-bold text-white tracking-wide",
                )}>
                    {entry.episodeCount} {t("home.rows.local_library_ep_short", "ép.")}
                </span>
            )}
            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent pointer-events-none">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {displayTitle}
                </p>
                {entry.year > 0 && (
                    <p className="text-white/70 text-xs">{entry.year}</p>
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
