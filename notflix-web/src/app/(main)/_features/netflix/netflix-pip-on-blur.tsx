/**
 * Mounted on /watch. Pops the playing <video> into Picture-in-Picture when
 * the tab becomes hidden (user switches app / opens a new tab), keeping the
 * stream alive in a floating corner window.
 *
 * Quietly does nothing when:
 *  - the browser doesn't support PiP (Firefox iOS, some embedded webviews)
 *  - the video element is paused / has no src yet
 *  - the user has explicitly disabled PiP via the player's disablePictureInPicture attribute
 *  - PiP is already active (avoid double-toggle on rapid focus changes)
 */
import * as React from "react"

export function NetflixPipOnBlur() {
    React.useEffect(() => {
        // Capability gate. document.pictureInPictureEnabled is false in
        // browsers that don't support PiP at all.
        if (typeof document === "undefined") return
        if (!document.pictureInPictureEnabled) return

        let lastBlurAt = 0

        const onVisibility = async () => {
            // Only act on hide. On show we let the user dismiss PiP themselves
            // (Netflix iOS behaviour — the PiP window persists across tab visits).
            if (document.visibilityState !== "hidden") return

            // Debounce: some browsers fire multiple visibilitychange events
            // when switching apps; ignore anything within 250ms of the last.
            const now = Date.now()
            if (now - lastBlurAt < 250) return
            lastBlurAt = now

            const video = document.querySelector("video") as HTMLVideoElement | null
            if (!video) return
            if (video.paused) return
            if ((video as any).disablePictureInPicture) return
            if (document.pictureInPictureElement === video) return

            try {
                await video.requestPictureInPicture()
            } catch {
                // User-gesture errors, permission denied, etc. — best-effort.
            }
        }

        document.addEventListener("visibilitychange", onVisibility)
        return () => document.removeEventListener("visibilitychange", onVisibility)
    }, [])

    return null
}
