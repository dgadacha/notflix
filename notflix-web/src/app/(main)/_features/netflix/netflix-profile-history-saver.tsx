/**
 * Mounted on /watch. Mirrors playback progress to the active profile's
 * history table (`/api/v1/notflix-profiles/:uid/history`).
 *
 * Save triggers, in increasing urgency:
 *   1. Periodic poll every POLL_MS (5s) while playing — covers the steady
 *      state of "user is just watching".
 *   2. `pause` event on the <video> — instant save when the user pauses.
 *   3. `seeked` event — instant save after the user scrubs.
 *   4. `visibilitychange` to hidden — fires when the user tabs away or
 *      switches app on mobile. More reliable than pagehide on iOS.
 *   5. `pagehide` / `beforeunload` — last-chance save on tab close. Uses
 *      `navigator.sendBeacon` because async fetch is unreliable during
 *      unload — beacon is the only API browsers actually wait on.
 *
 * The Continue Watching row reads the same endpoint, so progress survives
 * browser changes / cache wipes / device hops.
 */
import { pushProfileHistoryEntry, useActiveProfileId } from "@/lib/profiles/profiles"
import { useSearchParams } from "@/lib/navigation"
import { useQueryClient } from "@tanstack/react-query"
import * as React from "react"

const POLL_MS = 5000
const MIN_TIME_S = 3              // ignore the first ~3s — initial seek noise.
const INVALIDATE_EVERY_N = 6      // refresh the React-Query cache every ~30s of playback.

export function NetflixProfileHistorySaver() {
    const profileId = useActiveProfileId()
    const searchParams = useSearchParams()
    const idParam = searchParams.get("id")
    const epParam = searchParams.get("episode") ?? searchParams.get("ep")

    const mediaId = idParam ? parseInt(idParam, 10) : NaN
    const episodeNumber = epParam ? parseInt(epParam, 10) : NaN

    const queryClient = useQueryClient()

    React.useEffect(() => {
        if (!profileId) return
        if (Number.isNaN(mediaId) || Number.isNaN(episodeNumber)) return

        let cancelled = false
        let tickCount = 0
        let lastSavedAt = 0

        const findVideo = (): HTMLVideoElement | null =>
            document.querySelector("video") as HTMLVideoElement | null

        const buildEntry = () => {
            const video = findVideo()
            if (!video) return null
            const { currentTime, duration } = video
            if (!Number.isFinite(duration) || duration <= 0) return null
            if (currentTime < MIN_TIME_S) return null
            return { mediaId, episodeNumber, currentTime, duration }
        }

        // Async path — used by the periodic tick + pause/seek event handlers.
        const saveAsync = (debounce = false) => {
            if (cancelled) return
            const entry = buildEntry()
            if (!entry) return
            const now = Date.now()
            if (debounce && now - lastSavedAt < 1500) return  // dedupe seek-bursts
            lastSavedAt = now
            void pushProfileHistoryEntry(profileId, entry)
        }

        // Synchronous path — used during pagehide / beforeunload. fetch() is
        // unreliable here (browsers cancel pending requests on unload), but
        // navigator.sendBeacon is purpose-built for "ship this on the way out"
        // and browsers actually wait on it.
        const saveBeacon = () => {
            const entry = buildEntry()
            if (!entry) return
            try {
                const url = `/api/v1/notflix-profiles/${encodeURIComponent(profileId)}/history`
                const blob = new Blob([JSON.stringify(entry)], { type: "application/json" })
                // sendBeacon only supports POST; the backend's PUT route still
                // accepts the same body — but to be safe we fall back to fetch
                // if sendBeacon returns false (queue full or blocked).
                const ok = "sendBeacon" in navigator && navigator.sendBeacon(url, blob)
                if (!ok) {
                    void fetch(url, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(entry),
                        keepalive: true,
                    })
                }
            } catch { /* best-effort */ }
        }

        // ── Periodic poll ────────────────────────────────────────────────
        const interval = setInterval(() => {
            if (cancelled) return
            saveAsync(false)
            tickCount = (tickCount + 1) % INVALIDATE_EVERY_N
            if (tickCount === 0) {
                queryClient.invalidateQueries({ queryKey: ["notflix-profiles", profileId, "history"] })
            }
        }, POLL_MS)

        // ── Player events (instant save on pause / seek) ─────────────────
        const onPause = () => saveAsync(false)
        const onSeeked = () => saveAsync(true)

        // The <video> may not exist yet (player mounts after the splash). Wait
        // until it does, then attach. Re-uses one MutationObserver instead of
        // polling.
        let videoRef: HTMLVideoElement | null = null
        const attachVideo = (v: HTMLVideoElement) => {
            videoRef = v
            v.addEventListener("pause", onPause)
            v.addEventListener("seeked", onSeeked)
        }
        const detachVideo = () => {
            if (!videoRef) return
            videoRef.removeEventListener("pause", onPause)
            videoRef.removeEventListener("seeked", onSeeked)
            videoRef = null
        }

        const initialVideo = findVideo()
        if (initialVideo) attachVideo(initialVideo)

        const observer = new MutationObserver(() => {
            const v = findVideo()
            if (v && v !== videoRef) {
                detachVideo()
                attachVideo(v)
            }
        })
        observer.observe(document.body, { childList: true, subtree: true })

        // ── Visibility / unload (most reliable last-chance) ──────────────
        const onVisibility = () => {
            if (document.visibilityState === "hidden") saveBeacon()
        }
        const onUnload = () => saveBeacon()

        document.addEventListener("visibilitychange", onVisibility)
        window.addEventListener("pagehide", onUnload)
        window.addEventListener("beforeunload", onUnload)

        return () => {
            cancelled = true
            clearInterval(interval)
            detachVideo()
            observer.disconnect()
            document.removeEventListener("visibilitychange", onVisibility)
            window.removeEventListener("pagehide", onUnload)
            window.removeEventListener("beforeunload", onUnload)
        }
    }, [profileId, mediaId, episodeNumber, queryClient])

    return null
}
