import React from "react"

type Options = {
    /** Pause rotation while true (e.g. user hovering hero). */
    paused?: boolean
}

/**
 * Auto-cycling index over `length` items. Pauses on hover, when the tab is
 * hidden, and when the OS requests reduced motion. Does nothing for length ≤ 1.
 */
export function useSlideshow(length: number, intervalMs: number, opts: Options = {}) {
    const { paused = false } = opts
    const [index, setIndex] = React.useState(0)

    React.useEffect(() => {
        if (index >= length && length > 0) setIndex(0)
    }, [length, index])

    React.useEffect(() => {
        if (length <= 1 || paused) return
        if (typeof window === "undefined") return

        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        if (reducedMotion) return

        let timer: ReturnType<typeof setInterval> | null = null

        const start = () => {
            if (timer) return
            timer = setInterval(() => setIndex(i => (i + 1) % length), intervalMs)
        }
        const stop = () => {
            if (!timer) return
            clearInterval(timer)
            timer = null
        }
        const onVisibilityChange = () => {
            document.hidden ? stop() : start()
        }

        if (!document.hidden) start()
        document.addEventListener("visibilitychange", onVisibilityChange)

        return () => {
            stop()
            document.removeEventListener("visibilitychange", onVisibilityChange)
        }
    }, [length, intervalMs, paused])

    return [index, setIndex] as const
}
