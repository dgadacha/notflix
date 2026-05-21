/**
 * /categories — browse TMDB genres.
 *
 * Two states driven by URL search params so the user can deep-link:
 *
 *   ?type=movie|tv                — landing: pick a type, then a genre tile
 *   ?type=movie|tv&genre=<id>     — grid of films / series in that genre,
 *                                   sortable client-side
 *
 * Genre tiles get deterministic gradients (hash of the genre name → one
 * of six palette entries) so they look distinct without needing a TMDB
 * backdrop fetch per tile.
 */
import { NetflixCard } from "@/app/(main)/_features/netflix/netflix-card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/components/ui/core/styling"
import { useRouter, useSearchParams } from "@/lib/navigation"
import { useDiscover, useTMDBGenres } from "@/lib/tmdb"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiArrowBack } from "react-icons/bi"

// Curated six-gradient palette — picked to feel Netflix-y without
// fighting the brand red.
const GENRE_GRADIENTS = [
    "from-brand-500/80 to-purple-900",
    "from-blue-500/80 to-indigo-900",
    "from-pink-500/80 to-rose-900",
    "from-amber-500/80 to-orange-900",
    "from-emerald-500/80 to-teal-900",
    "from-cyan-500/80 to-sky-900",
] as const

function gradientFor(name: string): string {
    // Stable hash → gradient index. Same genre name always gets the
    // same tile colour.
    let hash = 0
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) | 0
    }
    const idx = Math.abs(hash) % GENRE_GRADIENTS.length
    return GENRE_GRADIENTS[idx]
}

export function NetflixCategories() {
    const { t } = useTranslation()
    const router = useRouter()
    const searchParams = useSearchParams()

    const typeParam = (searchParams.get("type") as "movie" | "tv" | null) ?? "movie"
    const genreParam = searchParams.get("genre")
    const genreId = genreParam ? parseInt(genreParam, 10) : null

    const { data: genresData, isLoading: genresLoading } = useTMDBGenres(typeParam)
    const genres = genresData?.genres ?? []

    const setType = (newType: "movie" | "tv") => {
        router.push(`/categories?type=${newType}`)
    }
    const selectGenre = (id: number) => {
        router.push(`/categories?type=${typeParam}&genre=${id}`)
    }
    const clearGenre = () => {
        router.push(`/categories?type=${typeParam}`)
    }

    // Genre grid is the landing state.
    if (!genreId) {
        return (
            <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-8 space-y-6 lg:space-y-8">
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                        {t("categories.title", "Catégories")}
                    </h1>
                    <div className="flex items-center gap-2">
                        <TypePill active={typeParam === "movie"} onClick={() => setType("movie")}>
                            {t("categories.movies", "Films")}
                        </TypePill>
                        <TypePill active={typeParam === "tv"} onClick={() => setType("tv")}>
                            {t("categories.tv", "Séries")}
                        </TypePill>
                    </div>
                </div>

                {genresLoading ? (
                    <GenreGridSkeleton />
                ) : (
                    <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 lg:gap-4">
                        {genres.map(g => (
                            <li key={g.id}>
                                <button
                                    type="button"
                                    onClick={() => selectGenre(g.id)}
                                    className={cn(
                                        "w-full aspect-[16/9] rounded-md overflow-hidden",
                                        "bg-gradient-to-br", gradientFor(g.name),
                                        "text-white text-lg lg:text-xl font-bold tracking-tight",
                                        "flex items-center justify-center text-center px-3",
                                        "transition-transform hover:scale-[1.03] hover:shadow-2xl transform-gpu",
                                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white",
                                    )}
                                >
                                    <span className="drop-shadow-[0_2px_8px_rgba(0,0,0,0.7)]">
                                        {g.name}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        )
    }

    return <GenreResults type={typeParam} genreId={genreId} genres={genres} onBack={clearGenre} />
}

// ---------------------------------------------------------------------------
// Single-genre browse view
// ---------------------------------------------------------------------------

function GenreResults({
    type,
    genreId,
    genres,
    onBack,
}: {
    type: "movie" | "tv"
    genreId: number
    genres: { id: number; name: string }[]
    onBack: () => void
}) {
    const { t } = useTranslation()
    // TMDB sort by popularity desc covers ~95% of the "browse a genre"
    // use case; we can add a sort selector later if needed.
    const discover = useDiscover(`/discover/${type}?with_genres=${genreId}&sort_by=popularity.desc`)
    const items = discover.data?.results ?? []
    const currentGenre = genres.find(g => g.id === genreId)

    return (
        <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-8 space-y-6 lg:space-y-8">
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={onBack}
                    aria-label={t("categories.back", "Retour aux catégories")}
                    className="p-2 rounded-full text-white hover:bg-white/10"
                >
                    <BiArrowBack className="size-6" />
                </button>
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                    {currentGenre?.name ?? t("categories.title", "Catégorie")}
                </h1>
                <span className="text-[--muted] text-sm">
                    {type === "tv" ? t("categories.tv", "Séries") : t("categories.movies", "Films")}
                </span>
            </div>

            {discover.isLoading ? (
                <ResultGridSkeleton />
            ) : items.length === 0 ? (
                <p className="text-center py-12 text-[--muted]">
                    {t("categories.empty", "Aucun titre trouvé pour ce genre.")}
                </p>
            ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-4 gap-y-6 py-2">
                    {items.map(m => (
                        <NetflixCard
                            key={m.id}
                            media={m}
                            variant="grid"
                            fallbackType={type}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function TypePill({
    active,
    onClick,
    children,
}: {
    active: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "px-4 py-1.5 text-sm font-semibold rounded-full transition-colors",
                active
                    ? "bg-brand-500 text-white"
                    : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white",
            )}
        >
            {children}
        </button>
    )
}

function GenreGridSkeleton() {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 lg:gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[16/9] rounded-md" />
            ))}
        </div>
    )
}

function ResultGridSkeleton() {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-4 gap-y-6">
            {Array.from({ length: 18 }).map((_, i) => (
                <Skeleton key={i} className="aspect-video rounded-md" />
            ))}
        </div>
    )
}
