/**
 * Dialog "Corriger le match TMDB" pour un fichier local mal indexé.
 *
 * Use case : le scan a confondu deux titres avec un nom proche
 * (eg. Spider-Man 1994 → Spider-Man 2003). L'admin ouvre ce
 * dialog, cherche le bon titre, clique dessus, et la row LocalFile
 * est patchée côté serveur. La rangée "Bibliothèque locale" se
 * refresh automatiquement.
 *
 * Le component est entièrement contrôlé : on lui passe `open` +
 * `onClose`, et il invalide la query `local-library` après un match
 * réussi (la rangée + la modal détail se mettent à jour).
 */
import type { LocalFile } from "@/app/(main)/_features/netflix/netflix-local-library"
import { Modal } from "@/components/ui/modal"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { tmdbImage } from "@/lib/tmdb"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import React from "react"

type TMDBSearchResult = {
    id: number
    mediaType: "movie" | "tv"
    title: string
    year: number
    posterPath: string
    overview: string
}

// Normalise les hits de l'endpoint /tmdb/search/{multi|tv|movie}.
// Le shape varie selon le type : `name`/`first_air_date` pour TV,
// `title`/`release_date` pour movie, `media_type` discriminator en
// mode multi.
function normaliseHit(raw: any, fallbackType?: "tv" | "movie"): TMDBSearchResult | null {
    const mt = (raw.media_type ?? fallbackType) as string
    if (mt !== "tv" && mt !== "movie") return null
    const title = (mt === "tv" ? raw.name : raw.title) ?? ""
    const date = (mt === "tv" ? raw.first_air_date : raw.release_date) ?? ""
    const year = date.length >= 4 ? parseInt(date.slice(0, 4), 10) || 0 : 0
    return {
        id: raw.id,
        mediaType: mt,
        title,
        year,
        posterPath: raw.poster_path ?? "",
        overview: raw.overview ?? "",
    }
}

function useTMDBSearch(query: string, type: "multi" | "tv" | "movie") {
    return useQuery<TMDBSearchResult[]>({
        queryKey: ["tmdb-search", type, query],
        queryFn: async () => {
            if (!query.trim()) return []
            const r = await fetch(`/api/v1/tmdb/search/${type}?query=${encodeURIComponent(query.trim())}`)
            if (!r.ok) throw new Error(`search ${r.status}`)
            const j = await r.json()
            const data = j.data ?? j
            const results = (data?.results ?? []) as any[]
            const fallback = type === "tv" || type === "movie" ? type : undefined
            return results
                .map(h => normaliseHit(h, fallback))
                .filter((h): h is TMDBSearchResult => h !== null)
                .slice(0, 20)
        },
        enabled: query.trim().length > 1,
        staleTime: 60_000,
    })
}

export function LocalLibraryMatchEditor({
    file,
    open,
    onClose,
}: {
    file: LocalFile | null
    open: boolean
    onClose: () => void
}) {
    const qc = useQueryClient()
    const [type, setType] = React.useState<"multi" | "tv" | "movie">("multi")
    const [query, setQuery] = React.useState("")
    const [submitting, setSubmitting] = React.useState<number | null>(null)
    const [error, setError] = React.useState<string | null>(null)

    // Pre-fill the search field with the parsed title + matching
    // type when the dialog opens for a different file.
    React.useEffect(() => {
        if (!file || !open) return
        setQuery(file.parsedTitle || file.title || "")
        setType((file.mediaType === "tv" || file.mediaType === "movie") ? file.mediaType : "multi")
        setError(null)
    }, [file?.id, open]) // eslint-disable-line react-hooks/exhaustive-deps

    const { data: results = [], isFetching } = useTMDBSearch(query, type)

    const handlePick = async (hit: TMDBSearchResult) => {
        if (!file) return
        setSubmitting(hit.id)
        setError(null)
        try {
            const r = await fetch(`/api/v1/local-library/match/${file.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tmdbId: hit.id, mediaType: hit.mediaType }),
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                throw new Error(j.error ?? `match ${r.status}`)
            }
            // Refresh everything touched by this row.
            qc.invalidateQueries({ queryKey: ["local-library"] })
            qc.invalidateQueries({ queryKey: ["local-file", file.id] })
            onClose()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setSubmitting(null)
        }
    }

    return (
        <Modal
            open={open}
            onOpenChange={(v) => { if (!v) onClose() }}
            title="Corriger le match TMDB"
            description={file ? `Fichier : ${file.path.split("/").pop()}` : undefined}
            contentClass="max-w-2xl"
        >
            <div className="space-y-3">
                {/* Search bar */}
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Rechercher un titre TMDB…"
                        className={cn(
                            "flex-1 bg-black/40 border border-white/15 rounded-md px-3 py-2",
                            "text-sm text-white outline-none focus:border-brand-500 font-mono",
                        )}
                    />
                    <select
                        value={type}
                        onChange={(e) => setType(e.target.value as "multi" | "tv" | "movie")}
                        className="bg-black/40 border border-white/15 rounded-md px-2 py-2 text-xs text-white outline-none focus:border-brand-500"
                    >
                        <option value="multi">Tout</option>
                        <option value="tv">Série</option>
                        <option value="movie">Film</option>
                    </select>
                </div>

                {error && (
                    <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                        {error}
                    </p>
                )}

                {/* Results */}
                <div className="max-h-[60vh] overflow-y-auto space-y-1.5 pr-1">
                    {isFetching && results.length === 0 && (
                        <>
                            {Array.from({ length: 5 }).map((_, i) => (
                                <Skeleton key={i} className="h-20 w-full rounded-md" />
                            ))}
                        </>
                    )}
                    {!isFetching && results.length === 0 && query.trim().length > 1 && (
                        <p className="text-[--muted] text-sm text-center py-8">
                            Aucun résultat pour « {query} ».
                        </p>
                    )}
                    {results.map(hit => (
                        <button
                            key={`${hit.mediaType}-${hit.id}`}
                            type="button"
                            onClick={() => handlePick(hit)}
                            disabled={submitting !== null}
                            className={cn(
                                "w-full text-left flex gap-3 p-2 rounded-md",
                                "bg-black/30 hover:bg-white/10 border border-white/5 hover:border-white/15",
                                "transition-colors disabled:opacity-50 disabled:cursor-wait",
                            )}
                        >
                            <div className="w-12 shrink-0 aspect-[2/3] bg-black/50 rounded overflow-hidden">
                                {hit.posterPath && (
                                    <img
                                        src={tmdbImage("w92", hit.posterPath)}
                                        alt=""
                                        className="w-full h-full object-cover"
                                        loading="lazy"
                                    />
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-baseline gap-2">
                                    <p className="text-white font-semibold text-sm truncate">
                                        {hit.title}
                                    </p>
                                    <span className="text-[10px] uppercase tracking-wider text-[--muted]">
                                        {hit.mediaType === "tv" ? "série" : "film"}
                                        {hit.year > 0 && ` · ${hit.year}`}
                                    </span>
                                </div>
                                {hit.overview && (
                                    <p className="text-[11px] text-[--muted] line-clamp-2 mt-0.5">
                                        {hit.overview}
                                    </p>
                                )}
                            </div>
                            {submitting === hit.id && (
                                <div className="self-center size-4 rounded-full border-2 border-white/10 border-t-brand-500 animate-spin" />
                            )}
                        </button>
                    ))}
                </div>
            </div>
        </Modal>
    )
}
