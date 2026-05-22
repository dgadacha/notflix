/**
 * Notflix backend API client — TorBox + Prowlarr endpoints.
 *
 * TMDB lives in `./tmdb.ts`. Profiles + watch history are in
 * `./profiles/profiles.ts` (carried over from Kuro, only path renamed).
 */
import { QueryClient, useMutation, useQuery } from "@tanstack/react-query"

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

/** Status of the per-session subtitle preparation pipeline. The watch
 *  page polls /api/v1/stream/hls/:sessionId/prep to drive a progress
 *  bar before transitioning to actual playback. */
export type SubPrepStatus = {
    /** "idle" / "picking" / "extracting" / "translating" / "ready" / "failed" */
    state: "idle" | "picking" | "extracting" | "translating" | "ready" | "failed"
    /** 0-100. Translation phase reports linear batch progress; extraction
     *  is bumped to fixed checkpoints since ffmpeg doesn't surface progress
     *  for subtitle remuxing. */
    progress: number
    /** Index into the session.subtitles list of the source we picked. -1
     *  when no usable source was found. */
    chosenSubIdx: number
    chosenLang: string
    willTranslate: boolean
    targetLang: string
    error?: string
}

/** One subtitle source the player can mount as a <track> element. */
export type SubtitleTrack = {
    /** "embedded" → /sub_<idx>.vtt route, "external" → /ext_<idx>.vtt. */
    source: "embedded" | "external"
    /** 0-based, per-source. NOT the global stream index. */
    index: number
    /** ffprobe codec_name for embedded subs, file extension (srt/ass/…)
     *  for external sidecar files. */
    codec: string
    /** ISO-639 tag, e.g. "fre" / "eng" / "jpn". May be empty. */
    language: string
    /** Optional descriptive label set by the muxer or the filename. */
    title: string
    /** True iff ffmpeg can convert to WebVTT (text-based subs).
     *  False for graphical formats like PGS/VobSub — we don't OCR yet. */
    supported: boolean
}

export type TorBoxPlayResult = {
    streamUrl: string
    torrentId: number
    fileId: number
    torrentName: string
    cached: boolean
    /** Lowercased ffprobe output for the first audio stream, e.g. "aac",
     *  "ac3", "eac3", "dts", "truehd". Empty string when probe fails or
     *  no audio stream was found. */
    audioCodec?: string
    /** First video stream codec — "h264" / "hevc" / "vp9" / "av1" / "xvid"
     *  / "". Drives the direct-vs-HLS decision in the player. */
    videoCodec?: string
    /** Comma-joined container format list from ffprobe, e.g.
     *  "mov,mp4,m4a,3gp,3g2,mj2" for MP4 or "matroska,webm" for MKV. */
    container?: string
    /** Total duration in seconds from ffprobe. 0 on probe failure. */
    durationSec?: number
    /** Embedded subtitle streams. Always sent (empty array when none). */
    subtitles?: SubtitleTrack[]
    /** HLS session id — used by both the transmuxed playback path AND
     *  the subtitle <track> URLs (/stream/hls/<id>/sub_<n>.vtt). Empty
     *  when ffprobe failed and no session could be opened. */
    sessionId?: string
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

/** Fire-and-forget POST that asks the backend to prepare a subtitle for
 *  the given language. Returns the initial status — frontend then polls
 *  the GET counterpart until state=ready / failed. */
export async function startSubPrep(sessionId: string, lang: string): Promise<SubPrepStatus> {
    const r = await fetch(`/api/v1/stream/hls/${sessionId}/prep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang }),
    })
    if (!r.ok) throw new Error(`prep start ${r.status}`)
    const j = await r.json()
    return j.data as SubPrepStatus
}

export async function getSubPrepStatus(sessionId: string): Promise<SubPrepStatus> {
    const r = await fetch(`/api/v1/stream/hls/${sessionId}/prep`)
    if (!r.ok) throw new Error(`prep status ${r.status}`)
    const j = await r.json()
    return j.data as SubPrepStatus
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
    // Server-computed streaming speed estimate:
    //   "instant"   = cached on TorBox (CDN)
    //   "fast"      = non-cached + 50+ seeders (saturates home ISP)
    //   "normal"    = non-cached + 10-49 seeders (smooth 1080p)
    //   "slow"      = non-cached + 3-9 seeders (likely to buffer)
    //   "very_slow" = non-cached + <3 seeders (basically dead)
    speedTier: "instant" | "fast" | "normal" | "slow" | "very_slow"
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

/**
 * Fire-and-forget warmups used by the home cards on hover. They share
 * a query key with useSearchMovie / useSearchTV so the actual /watch
 * mount picks up the cached result instantly when the user clicks.
 *
 * The hover delay (~300ms) lives at the call site — we don't want a
 * scroll past the row to spam Prowlarr.
 */
export function prefetchSearchMovie(qc: QueryClient, title: string, year?: number) {
    if (!title) return
    return qc.prefetchQuery({
        queryKey: ["prowlarr", "search", "movie", title, year],
        queryFn: () => jget<Release[]>(
            `/prowlarr/search/movie?title=${encodeURIComponent(title)}${year ? `&year=${year}` : ""}`,
        ),
        staleTime: 5 * 60_000,
    })
}

export function prefetchSearchTV(qc: QueryClient, title: string, season?: number, episode?: number) {
    if (!title) return
    const q = new URLSearchParams({ title })
    if (season) q.set("season", String(season))
    if (episode) q.set("episode", String(episode))
    return qc.prefetchQuery({
        queryKey: ["prowlarr", "search", "tv", title, season, episode],
        queryFn: () => jget<Release[]>(`/prowlarr/search/tv?${q}`),
        staleTime: 5 * 60_000,
    })
}
