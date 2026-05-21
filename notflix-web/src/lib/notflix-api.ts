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

export function useTorBoxPlay() {
    return useMutation<TorBoxPlayResult, Error, { magnet: string; fileId?: number }>({
        mutationFn: (body) => jpost("/torbox/play", body),
    })
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
