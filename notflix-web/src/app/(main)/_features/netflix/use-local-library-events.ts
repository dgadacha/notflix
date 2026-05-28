/**
 * Subscribes the browser to /api/v1/local-library/events (Server-Sent
 * Events). The backend pushes one message every time the fsnotify
 * watcher detects a new file landing in the library directory and the
 * scanner resolves the TMDB metadata.
 *
 * On each event:
 *   - Fire a sonner toast: "Foo (2024) ajouté à la bibliothèque"
 *   - Invalidate the local-library + scan-status queries so the home
 *     rail refreshes and the Settings panel's breakdown counters tick
 *     up immediately.
 *
 * The native EventSource API auto-reconnects on disconnect, so we
 * don't manage retries ourselves. We DO bail out if the user isn't
 * authenticated (the endpoint would 401 in a loop otherwise).
 */
import { useCurrentUser } from "@/lib/auth"
import { useQueryClient } from "@tanstack/react-query"
import React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

type LibraryEvent = {
    kind: "added" | "removed"
    title: string
    mediaType: "movie" | "tv"
    tmdbId: number
    path: string
    season?: number
    episode?: number
    at: string
}

export function useLocalLibraryEvents() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const { data: user } = useCurrentUser()
    const userId = user?.id

    React.useEffect(() => {
        if (!userId) return
        // Same-origin so the session cookie rides along automatically.
        const es = new EventSource("/api/v1/local-library/events")

        es.onmessage = (msg) => {
            let ev: LibraryEvent
            try {
                ev = JSON.parse(msg.data) as LibraryEvent
            } catch {
                return
            }
            if (ev.kind !== "added") return

            // Build a label like "Dune" or "Euphoria S01E01" so a
            // newly-added TV episode shows what specifically landed.
            const isTV = ev.mediaType === "tv"
            const epLabel = isTV && ev.season && ev.episode
                ? ` S${String(ev.season).padStart(2, "0")}E${String(ev.episode).padStart(2, "0")}`
                : ""
            const title = `${ev.title}${epLabel}`

            toast.success(
                t("library.toast_added", "{{title}} ajouté à la bibliothèque", { title }),
                {
                    description: isTV
                        ? t("library.toast_added_tv", "Nouvel épisode détecté")
                        : t("library.toast_added_movie", "Nouveau film détecté"),
                    duration: 6000,
                },
            )

            // Refresh the home rail + the settings breakdown counters.
            qc.invalidateQueries({ queryKey: ["local-library"] })
            qc.invalidateQueries({ queryKey: ["library", "scan-status"] })
        }

        es.onerror = () => {
            // EventSource auto-retries on its own (3 s default). We log
            // to the console for diagnostics but don't surface a toast
            // — transient reconnects are normal (eg. when the user's
            // laptop wakes from sleep).
            // eslint-disable-next-line no-console
            console.debug("library-events: stream error, EventSource will reconnect")
        }

        return () => es.close()
    }, [userId, qc, t])
}
