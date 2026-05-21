/**
 * Notflix search — TMDB-backed multi-search (films + séries + people, though
 * the card grid filters to movies + tv only since people don't have a watch
 * page).
 */
import { NetflixCard } from "@/app/(main)/_features/netflix/netflix-card"
import { Skeleton } from "@/components/ui/skeleton"
import { TextInput } from "@/components/ui/text-input"
import { useDebounce } from "@/hooks/use-debounce"
import { TMDBMedia, useTMDBSearch } from "@/lib/tmdb"
import React from "react"
import { useTranslation } from "react-i18next"
import { FiSearch } from "react-icons/fi"

export function NetflixSearch() {
    const { t } = useTranslation()
    const [input, setInput] = React.useState("")
    const debounced = useDebounce(input.trim(), 350)

    const enabled = debounced.length >= 2
    const { data, isFetching } = useTMDBSearch(enabled ? debounced : "")

    // Drop person results — only movie / tv have a useful card.
    const media: TMDBMedia[] = React.useMemo(
        () =>
            (data?.results ?? []).filter(
                (m) => m.media_type === "movie" || m.media_type === "tv",
            ),
        [data],
    )

    return (
        <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-8 space-y-8 lg:space-y-10">
            <div className="max-w-3xl mx-auto space-y-4 lg:space-y-5 text-center">
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                    {t("search.title", "Rechercher")}
                </h1>
                <TextInput
                    autoFocus
                    size="lg"
                    placeholder={t("search.placeholder", "Films, séries…")}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    leftIcon={<FiSearch className="size-5" />}
                    className="!h-14 !text-base bg-white/5 border-white/10 !text-white placeholder:text-[--muted] rounded-full !pl-14 !pr-6"
                />
            </div>

            {!enabled && (
                <p className="text-center text-[--muted] py-12">
                    {t("search.start_typing", "Tapez au moins 2 caractères pour lancer la recherche.")}
                </p>
            )}

            {enabled && isFetching && media.length === 0 && (
                <ResultGrid>
                    {Array.from({ length: 12 }).map((_, i) => (
                        <Skeleton key={i} className="w-full aspect-video rounded-md" />
                    ))}
                </ResultGrid>
            )}

            {enabled && !isFetching && media.length === 0 && (
                <p className="text-center text-[--muted] py-12">
                    {t("search.no_results", "Aucun résultat.")}
                </p>
            )}

            {media.length > 0 && (
                <ResultGrid>
                    {media.map(m => (
                        <NetflixCard
                            key={`${m.media_type}-${m.id}`}
                            media={m}
                            variant="grid"
                        />
                    ))}
                </ResultGrid>
            )}
        </div>
    )
}

/** Grid with vertical breathing room so card hover-scale doesn't crash into rows above/below. */
function ResultGrid({ children }: { children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-4 gap-y-6 py-2">
            {children}
        </div>
    )
}
