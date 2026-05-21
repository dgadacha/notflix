/**
 * Notflix backend API client — TorBox + Prowlarr endpoints.
 *
 * TMDB lives in `./tmdb.ts`. Profiles + watch history are in
 * `./profiles/profiles.ts` (carried over from Kuro, only path renamed).
 */
import { useMutation, useQuery } from "@tanstack/react-query"

const BASE = "/api/v1"

async function jget<T>(path: string): Promise<T> {
    const r = await fetch(BASE + path)
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => "")}`)
    const j = await r.json()
    return j.data as T
}

async function jpost<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => "")}`)
    const j = await r.json()
    return j.data as T
}

// --------------------------------------------------------------------------
// /api/v1/torbox/*
// --------------------------------------------------------------------------

export type TorBoxStatus = {
    configured: boolean
    email?: string
    plan?: number
    isSubscribed?: boolean
    premiumExpiresAt?: string
}

export function useTorBoxStatus() {
    return useQuery<TorBoxStatus>({
        queryKey: ["torbox", "status"],
        queryFn: () => jget("/torbox/status"),
        staleTime: 60_000,
    })
}

export type TorBoxPlayResult = {
    streamUrl: string
    torrentId: number
    fileId: number
    torrentName: string
    cached: boolean
}

/**
 * Resolve a Prowlarr release to a TorBox stream URL. The backend accepts
 * either a magnet URI (when the indexer exposes one) or a Prowlarr download
 * URL (when it doesn't — the backend fetches the .torrent server-side then
 * uploads its bytes to TorBox, since TorBox can't reach a private Prowlarr).
 */
export type TorBoxPlayBody = {
    magnet?: string
    downloadUrl?: string
    fileId?: number
}

export function useTorBoxPlay() {
    return useMutation<TorBoxPlayResult, Error, TorBoxPlayBody>({
        mutationFn: (body) => jpost("/torbox/play", body),
    })
}

/**
 * Build the TorBox /play body for a Prowlarr release, picking the most
 * trustworthy source field.
 *
 * Prowlarr is inconsistent across indexers: some return a true magnet:?…
 * URI in `magnetUrl`, others stuff their own /download HTTP proxy URL in
 * the same field (looks like a magnet to a naive caller but TorBox
 * rejects it with BOZO_TORRENT). Order of preference:
 *
 *   1. magnetUrl, ONLY if it actually starts with "magnet:"
 *   2. infoHash → synthesise a magnet (every BTIH cached release works)
 *   3. downloadUrl OR magnetUrl-as-downloadUrl → backend fetches the
 *      .torrent server-side
 *
 * Returns null if none of the three is usable — the caller should mark
 * the release as bad and try the next one.
 */
export function releaseTorBoxPayload(r: Release): TorBoxPlayBody | null {
    if (r.magnetUrl && r.magnetUrl.toLowerCase().startsWith("magnet:")) {
        return { magnet: r.magnetUrl }
    }
    if (r.infoHash) {
        const dn = encodeURIComponent(r.title || "")
        return { magnet: `magnet:?xt=urn:btih:${r.infoHash}&dn=${dn}` }
    }
    // Some indexers shove a Prowlarr download URL into magnetUrl. Treat
    // it as downloadUrl so the backend fetches the .torrent.
    const dl = r.downloadUrl || (r.magnetUrl && !r.magnetUrl.toLowerCase().startsWith("magnet:") ? r.magnetUrl : "")
    if (dl) return { downloadUrl: dl }
    return null
}

// --------------------------------------------------------------------------
// /api/v1/prowlarr/search/*
// --------------------------------------------------------------------------

export type Release = {
    guid: string
    title: string
    indexer: string
    protocol: string
    size: number
    seeders: number
    leechers: number
    publishDate: string
    magnetUrl: string
    downloadUrl: string
    infoHash: string
    cached: boolean
    quality: string
    score: number
}

export type ProwlarrStatus = {
    configured: boolean
    appName?: string
    version?: string
    indexerCount?: number
    enabledIndexers?: number
}

export function useProwlarrStatus() {
    return useQuery<ProwlarrStatus>({
        queryKey: ["prowlarr", "status"],
        queryFn: () => jget("/prowlarr/status"),
        staleTime: 60_000,
    })
}

export function useSearchMovie(title: string, year?: number) {
    return useQuery<Release[]>({
        queryKey: ["prowlarr", "search", "movie", title, year],
        queryFn: () => jget(`/prowlarr/search/movie?title=${encodeURIComponent(title)}${year ? `&year=${year}` : ""}`),
        enabled: !!title,
        staleTime: 5 * 60_000, // search is expensive, cache 5 min
    })
}

export function useSearchTV(title: string, season?: number, episode?: number) {
    const q = new URLSearchParams({ title })
    if (season) q.set("season", String(season))
    if (episode) q.set("episode", String(episode))
    return useQuery<Release[]>({
        queryKey: ["prowlarr", "search", "tv", title, season, episode],
        queryFn: () => jget(`/prowlarr/search/tv?${q}`),
        enabled: !!title,
        staleTime: 5 * 60_000,
    })
}
