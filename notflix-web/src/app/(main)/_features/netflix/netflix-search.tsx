/**
 * Notflix search — TMDB-backed multi-search (films + séries + people, though
 * the card grid filters to movies + tv only since people don't have a watch
 * page).
 */
import { NetflixCard } from "@/app/(main)/_features/netflix/netflix-card"
import { Skeleton } from "@/components/ui/skeleton"
import { TextInput } from "@/components/ui/text-input"
import { useDebounce } from "@/hooks/use-debounce"
import { TMDBMedia, useInfiniteTMDBSearch } from "@/lib/tmdb"
import React from "react"
import { useTranslation } from "react-i18next"
import { FiLoader, FiSearch } from "react-icons/fi"

export function NetflixSearch() {
    const { t } = useTranslation()
    const [input, setInput] = React.useState("")
    const debounced = useDebounce(input.trim(), 350)

    const enabled = debounced.length >= 2
    const search = useInfiniteTMDBSearch(enabled ? debounced : "")

    // Flatten paged results, drop person hits (they don't have a useful
    // card), and dedupe across page boundaries (TMDB does repeat).
    const media: TMDBMedia[] = React.useMemo(() => {
        const out: TMDBMedia[] = []
        const seen = new Set<string>()
        for (const page of search.data?.pages ?? []) {
            for (const m of page.results ?? []) {
                if (m.media_type !== "movie" && m.media_type !== "tv") continue
                const k = `${m.media_type}-${m.id}`
                if (seen.has(k)) continue
                seen.add(k)
                out.push(m)
            }
        }
        return out
    }, [search.data])

    // Same intersection-observer pattern as /categories — sentinel one
    // screen above the bottom of the grid, fetches the next page when
    // it enters view.
    const sentinelRef = React.useRef<HTMLDivElement>(null)
    React.useEffect(() => {
        const el = sentinelRef.current
        if (!el) return
        if (!search.hasNextPage) return
        const obs = new IntersectionObserver(
            entries => {
                if (entries[0].isIntersecting && !search.isFetchingNextPage) {
                    void search.fetchNextPage()
                }
            },
            { rootMargin: "400px" },
        )
        obs.observe(el)
        return () => obs.disconnect()
    }, [search.hasNextPage, search.isFetchingNextPage, search.fetchNextPage])

    const showInitialSkeletons = enabled && search.isFetching && media.length === 0

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

            {showInitialSkeletons && (
                <ResultGrid>
                    {Array.from({ length: 12 }).map((_, i) => (
                        <Skeleton key={i} className="w-full aspect-video rounded-md" />
                    ))}
                </ResultGrid>
            )}

            {enabled && !search.isFetching && media.length === 0 && (
                <p className="text-center text-[--muted] py-12">
                    {t("search.no_results", "Aucun résultat.")}
                </p>
            )}

            {media.length > 0 && (
                <>
                    <ResultGrid>
                        {media.map(m => (
                            <NetflixCard
                                key={`${m.media_type}-${m.id}`}
                                media={m}
                                variant="grid"
                            />
                        ))}
                    </ResultGrid>

                    {search.hasNextPage && (
                        <div ref={sentinelRef} className="py-8 flex items-center justify-center gap-2 text-[--muted]">
                            {search.isFetchingNextPage && (
                                <>
                                    <FiLoader className="size-5 animate-spin" />
                                    <span className="text-sm">{t("search.loading_more", "Chargement…")}</span>
                                </>
                            )}
                        </div>
                    )}
                </>
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
