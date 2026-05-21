/**
 * TMDB client + hooks for Notflix.
 *
 * All requests go through the local Go backend (`/api/v1/tmdb/*`), which
 * forwards them to TMDB with the API key attached server-side. The frontend
 * never sees the key.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"

// --------------------------------------------------------------------------
// Types — the subset of TMDB's schema Notflix actually uses
// --------------------------------------------------------------------------

export type TMDBMedia = {
    id: number
    /** "movie" | "tv" | "person" — sometimes absent on /discover endpoints. */
    media_type?: "movie" | "tv" | "person"
    title?: string         // movies
    name?: string          // tv
    original_title?: string
    original_name?: string
    overview?: string
    poster_path?: string | null
    backdrop_path?: string | null
    vote_average?: number
    vote_count?: number
    release_date?: string   // movies
    first_air_date?: string // tv
    genre_ids?: number[]
    genres?: { id: number; name: string }[]
    runtime?: number
    number_of_seasons?: number
    number_of_episodes?: number
    seasons?: TMDBSeason[]
    external_ids?: { imdb_id?: string }
}

export type TMDBSeason = {
    id: number
    season_number: number
    name: string
    episode_count: number
    air_date?: string | null
    overview?: string
    poster_path?: string | null
}

export type TMDBEpisode = {
    id: number
    episode_number: number
    season_number: number
    name: string
    overview?: string
    runtime?: number | null
    air_date?: string | null
    still_path?: string | null
    vote_average?: number
}

export type TMDBSeasonDetail = {
    id: number
    season_number: number
    name: string
    overview?: string
    air_date?: string | null
    episodes: TMDBEpisode[]
}

export type TMDBPaged<T = TMDBMedia> = {
    page: number
    total_pages: number
    total_results: number
    results: T[]
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

export const titleOf = (m: TMDBMedia) => m.title || m.name || ""
export const yearOf  = (m: TMDBMedia) =>
    (m.release_date || m.first_air_date || "").slice(0, 4)

/**
 * Build a URL for a TMDB image. Routes through the backend's cache proxy
 * (`/api/v1/tmdb/img/<size>/<path>`) so the file is served from local
 * disk after the first hit — instant on repeat loads, immune to browser
 * cache evictions, and the request count to TMDB drops to once per
 * unique image.
 *
 * Backwards-compatible signature: pass the TMDB path verbatim (with or
 * without the leading slash). Empty path → empty string (caller checks).
 */
export const tmdbImage = (size: string, p?: string | null) => {
    if (!p) return ""
    const cleaned = p.startsWith("/") ? p.slice(1) : p
    return `/api/v1/tmdb/img/${size}/${cleaned}`
}

export function mediaTypeOf(m: TMDBMedia, fallback: "movie" | "tv" = "movie"): "movie" | "tv" {
    if (m.media_type === "movie" || m.media_type === "tv") return m.media_type
    return fallback
}

// --------------------------------------------------------------------------
// Low-level fetcher
// --------------------------------------------------------------------------

async function tmdbFetch<T = any>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const qs = new URLSearchParams()
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== "") qs.set(k, String(v))
        }
    }
    const url = `/api/v1/tmdb${path}${qs.toString() ? `?${qs}` : ""}`
    const r = await fetch(url)
    if (!r.ok) {
        const text = await r.text().catch(() => "")
        throw new Error(`TMDB ${r.status}: ${text}`)
    }
    return r.json() as Promise<T>
}

// --------------------------------------------------------------------------
// React Query hooks
// --------------------------------------------------------------------------

export function useTrending(mediaType: "movie" | "tv", window: "day" | "week" = "week") {
    return useQuery<TMDBPaged>({
        queryKey: ["tmdb", "trending", mediaType, window],
        queryFn: () => tmdbFetch(`/trending/${mediaType}/${window}`),
    })
}

export function useDiscover(path: string) {
    return useQuery<TMDBPaged>({
        queryKey: ["tmdb", "discover", path],
        queryFn: () => tmdbFetch(path),
    })
}

/**
 * Paginated variant of useDiscover for the /categories grid — fetches
 * the first page on mount and lets the caller pull more via fetchNextPage().
 *
 * `path` should be the TMDB endpoint without a `page` param; we append
 * `?page=N` (or `&page=N`) per page. Stops paging when TMDB reports
 * page >= total_pages (TMDB hard-caps total_pages at 500 even when the
 * real result count is higher).
 */
export function useInfiniteDiscover(path: string) {
    return useInfiniteQuery<TMDBPaged>({
        queryKey: ["tmdb", "discover-infinite", path],
        queryFn: ({ pageParam = 1 }) => {
            const sep = path.includes("?") ? "&" : "?"
            return tmdbFetch<TMDBPaged>(`${path}${sep}page=${pageParam}`)
        },
        initialPageParam: 1,
        getNextPageParam: (lastPage) => {
            if (!lastPage) return undefined
            if (lastPage.page >= lastPage.total_pages) return undefined
            return lastPage.page + 1
        },
        enabled: !!path,
    })
}

export function useTMDBDetail(type: "movie" | "tv", id: number | string | null) {
    return useQuery<TMDBMedia>({
        queryKey: ["tmdb", type, String(id)],
        queryFn: () => tmdbFetch(`/${type}/${id}`, { append_to_response: "credits,videos,external_ids" }),
        enabled: !!id,
    })
}

/**
 * One season's full episode list. Used by the detail modal's TV series
 * picker — TMDB's /tv/{id} response gives season metadata (count, air
 * date, poster) but not the per-episode rows.
 */
export function useTMDBSeason(tvId: number | string | null, seasonNumber: number | null) {
    return useQuery<TMDBSeasonDetail>({
        queryKey: ["tmdb", "tv", String(tvId), "season", seasonNumber],
        queryFn: () => tmdbFetch(`/tv/${tvId}/season/${seasonNumber}`),
        enabled: !!tvId && seasonNumber != null && seasonNumber >= 0,
    })
}

export function useTMDBSearch(query: string) {
    return useQuery<TMDBPaged>({
        queryKey: ["tmdb", "search", query],
        queryFn: () => tmdbFetch("/search/multi", { query }),
        enabled: query.trim().length >= 2,
    })
}

// --------------------------------------------------------------------------
// Genres — used by the /categories browse page
// --------------------------------------------------------------------------

export type TMDBGenre = { id: number; name: string }

export function useTMDBGenres(type: "movie" | "tv") {
    return useQuery<{ genres: TMDBGenre[] }>({
        queryKey: ["tmdb", "genres", type],
        queryFn: () => tmdbFetch(`/genre/${type}/list`),
        // Genre list changes once in a blue moon — keep it cached all day.
        staleTime: 24 * 60 * 60 * 1000,
    })
}
