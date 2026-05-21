/**
 * Per-profile watch history mirror.
 *
 * Mounted on /watch alongside the player. Polls the live <video>
 * element every 5 seconds (plus on pagehide/beforeunload) and PUTs
 * the position to `/api/v1/profiles/:uid/history`. The endpoint is
 * idempotent on (profileUid, tmdbId, mediaType, season, episode), so
 * a 5s tick frequency is harmless.
 *
 * No-op when there's no active profile — single-user mode falls back
 * to the browser's own history.
 *
 * Decoupled from the rest of the player on purpose: it grabs the
 * <video> via `document.querySelector("video")` rather than threading
 * a ref through the player. The /watch page can swap between native
 * playback and hls.js attachMedia and this still works.
 */
import {
    useActiveProfileId,
    useProfileHistoryUpsert,
    WatchHistoryUpsertBody,
} from "@/lib/profiles/profiles"
import * as React from "react"

type Props = {
    tmdbId: number
    mediaType: "movie" | "tv"
    season?: number
    episode?: number
    title: string
    posterPath: string
    backdropUrl: string
}

const POLL_INTERVAL_MS = 5_000
// Ignore the first few seconds — no point persisting "0:03" if the
// player aborts in the splash.
const MIN_TIME_TO_PERSIST = 5

export function NetflixWatchHistorySaver({
    tmdbId,
    mediaType,
    season,
    episode,
    title,
    posterPath,
    backdropUrl,
}: Props) {
    const profileUid = useActiveProfileId()
    const upsert = useProfileHistoryUpsert()

    // Stable reference so the polling effect doesn't restart on every
    // <video> currentTime tick.
    const payloadRef = React.useRef<Omit<WatchHistoryUpsertBody, "currentTime" | "duration">>({
        tmdbId,
        mediaType,
        season: season ?? 0,
        episode: episode ?? 0,
        title,
        posterPath,
        backdropUrl,
    })
    React.useEffect(() => {
        payloadRef.current = {
            tmdbId,
            mediaType,
            season: season ?? 0,
            episode: episode ?? 0,
            title,
            posterPath,
            backdropUrl,
        }
    }, [tmdbId, mediaType, season, episode, title, posterPath, backdropUrl])

    React.useEffect(() => {
        if (!profileUid) return

        const tick = () => {
            const video = document.querySelector("video")
            if (!video) return
            const currentTime = video.currentTime
            const duration = video.duration
            if (!Number.isFinite(currentTime) || currentTime < MIN_TIME_TO_PERSIST) return
            if (!Number.isFinite(duration) || duration <= 0) return

            void upsert({
                ...payloadRef.current,
                currentTime,
                duration,
            })
        }

        const interval = window.setInterval(tick, POLL_INTERVAL_MS)
        const onPageHide = () => tick()
        window.addEventListener("pagehide", onPageHide)
        window.addEventListener("beforeunload", onPageHide)

        return () => {
            clearInterval(interval)
            window.removeEventListener("pagehide", onPageHide)
            window.removeEventListener("beforeunload", onPageHide)
            // One last tick on unmount — if the user clicks Retour, we
            // want the position they were at, not the one from 5s ago.
            tick()
        }
    }, [profileUid, upsert])

    return null
}
