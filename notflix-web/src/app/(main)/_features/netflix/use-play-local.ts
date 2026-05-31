/**
 * usePlayLocal — routing factory pour un click "lecture" sur un
 * fichier de la bibliothèque locale.
 *
 *   source="local"  → /watch?localId=N (stream HTTP Range natif)
 *   source="torbox" → POST /resolve-stream pour récupérer une URL
 *                     TorBox fraîche + metadata, stash dans
 *                     sessionStorage, navigate /watch?customStream=1
 *
 * Les URLs TorBox expirent (~24h) donc on les résout juste-à-temps.
 */
import type { LocalFile } from "@/app/(main)/_features/netflix/netflix-local-library"
import { useRouter } from "@/lib/navigation"
import React from "react"

const STASH_KEY = "notflix-custom-stream"

export function usePlayLocal() {
    const router = useRouter()
    const [resolving, setResolving] = React.useState<number | null>(null)
    const [error, setError] = React.useState<string | null>(null)

    const playLocalFile = React.useCallback(async (file: LocalFile, resumeSec = 0) => {
        // Default-local for old rows that don't have a source field.
        const src = file.source ?? "local"
        if (src === "local") {
            const params = new URLSearchParams({ localId: String(file.id) })
            if (resumeSec > 0) params.set("t", String(Math.floor(resumeSec)))
            router.push(`/watch?${params.toString()}`)
            return
        }

        // TorBox: resolve, stash, navigate with customStream flag.
        setResolving(file.id)
        setError(null)
        try {
            const r = await fetch(`/api/v1/local-library/resolve-stream/${file.id}`, {
                method: "POST",
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                throw new Error(j.error ?? `resolve ${r.status}`)
            }
            const j = await r.json()
            const data = j.data ?? j
            const context = {
                tmdbId: file.tmdbId,
                mediaType: (file.mediaType === "tv" ? "tv" : "movie") as "movie" | "tv",
                title: file.title,
                posterPath: file.posterPath,
                backdropPath: file.backdropPath,
                season: file.season,
                episode: file.episode,
            }
            try {
                sessionStorage.setItem(STASH_KEY, JSON.stringify({
                    ...data,
                    context,
                    expiresAt: Date.now() + 60_000,
                }))
            } catch {
                // best-effort
            }
            const params = new URLSearchParams({
                customStream: "1",
                id: String(file.tmdbId),
                type: file.mediaType === "tv" ? "tv" : "movie",
            })
            if (file.mediaType === "tv") {
                if (file.season > 0) params.set("season", String(file.season))
                if (file.episode > 0) params.set("episode", String(file.episode))
            }
            if (resumeSec > 0) params.set("t", String(Math.floor(resumeSec)))
            router.push(`/watch?${params.toString()}`)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setResolving(null)
        }
    }, [router])

    return { playLocalFile, resolving, error }
}
