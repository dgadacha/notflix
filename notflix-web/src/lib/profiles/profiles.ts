/**
 * Netflix-style multi-profile support — server-backed.
 *
 * Persistence layer: SQLite, exposed via `/api/v1/profiles` (see Go side
 * in `internal/database/db/profile.go` + `internal/handlers/profiles.go`).
 * Profiles + watch history + per-profile list therefore survive browser
 * changes, devices, incognito, cache wipes — anything that's not "the
 * server's PVC vanished".
 *
 * The frontend only stores ONE thing locally: the currently-active profile
 * uid (a UI preference — which profile is selected for THIS browser
 * session).
 *
 * Schema mirrors `internal/database/models.go` exactly:
 *   - watch history is keyed by (profile, tmdbId, mediaType, season, episode)
 *   - list entries are keyed by (profile, tmdbId, mediaType)
 *
 * Movies use season=0, episode=0; TV episodes carry the real numbers so
 * "Reprendre la lecture" can resume the right episode.
 */
import { useServerMutation, useServerQuery } from "@/api/client/requests"
import { useQueryClient } from "@tanstack/react-query"
import { atom, useAtom, useAtomValue } from "jotai"
import { atomWithStorage } from "jotai/utils"
import * as React from "react"

// -----------------------------------------------------------------------------
// Types — mirror the Go models 1:1
// -----------------------------------------------------------------------------

export type Profile = {
    id: number
    uid: string
    name: string
    avatar: string
    color: string
    createdAt: string
    updatedAt: string
}

export type ProfileWatchEntry = {
    id: number
    profileUid: string
    tmdbId: number
    mediaType: "movie" | "tv"
    season: number      // 0 for movies
    episode: number     // 0 for movies
    currentTime: number
    duration: number
    title: string
    posterPath: string
    backdropUrl: string
    createdAt: string
    updatedAt: string
}

export type ProfileListStatus = "WATCHING" | "PLANNING" | "COMPLETED" | "DROPPED"

export type ProfileListEntry = {
    id: number
    profileUid: string
    tmdbId: number
    mediaType: "movie" | "tv"
    status: ProfileListStatus
    title: string
    posterPath: string
    createdAt: string
    updatedAt: string
}

export const PROFILE_AVATARS = [
    "🐱", "🐶", "🦊", "🐰", "🐼", "🐯",
    "🐸", "🐙", "🦁", "🐺", "🦄", "🌸",
    "⚡", "🔥", "🎌", "📺", "🎮", "🍙",
    "🌙", "👤", "🎨", "🍿", "🥷", "👑",
] as const

export const PROFILE_COLORS = [
    "#E50914", "#F5A623", "#FBBF24", "#10B981",
    "#06B6D4", "#3B82F6", "#A855F7", "#EC4899",
] as const

// -----------------------------------------------------------------------------
// Endpoint constants
// -----------------------------------------------------------------------------

const EP_LIST = "/api/v1/profiles"
const EP_CREATE = "/api/v1/profiles"
const EP_PATCH = (uid: string) => `/api/v1/profiles/${encodeURIComponent(uid)}`
const EP_DELETE = (uid: string) => `/api/v1/profiles/${encodeURIComponent(uid)}`
const EP_HISTORY = (uid: string) => `/api/v1/profiles/${encodeURIComponent(uid)}/history`
const EP_PROFILE_LIST = (uid: string) => `/api/v1/profiles/${encodeURIComponent(uid)}/list`

const QK_PROFILES = ["profiles"] as const
const QK_HISTORY = (uid: string) => ["profiles", uid, "history"] as const
const QK_PROFILE_LIST = (uid: string) => ["profiles", uid, "list"] as const

// -----------------------------------------------------------------------------
// Active-profile selection (purely client-side — which profile is "current")
// -----------------------------------------------------------------------------

const STORAGE_ACTIVE = "notflix-active-profile"

export const activeProfileUidAtom = atomWithStorage<string | null>(STORAGE_ACTIVE, null)

// Backwards-compat alias.
export const activeProfileIdAtom = activeProfileUidAtom

export function useActiveProfileId(): string | null {
    return useAtomValue(activeProfileUidAtom)
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

export function useProfiles() {
    const q = useServerQuery<Profile[]>({
        endpoint: EP_LIST,
        method: "GET",
        queryKey: [...QK_PROFILES],
    })
    return q.data ?? []
}

export function useProfilesQuery() {
    const q = useServerQuery<Profile[]>({
        endpoint: EP_LIST,
        method: "GET",
        queryKey: [...QK_PROFILES],
    })
    return { profiles: q.data ?? [], isLoading: q.isLoading, isFetched: q.isFetched }
}

export function useActiveProfile(): Profile | null {
    const profiles = useProfiles()
    const uid = useActiveProfileId()
    if (!uid) return null
    return profiles.find(p => p.uid === uid) ?? null
}

/**
 * Live history for the active profile — most-recent first. Returns [] when no
 * profile is active so callers can render unconditionally.
 */
export function useActiveProfileHistory(): ProfileWatchEntry[] {
    const uid = useActiveProfileId()
    const q = useServerQuery<ProfileWatchEntry[]>({
        endpoint: uid ? EP_HISTORY(uid) : "",
        method: "GET",
        queryKey: uid ? [...QK_HISTORY(uid)] : ["profiles", "history", "noop"],
        enabled: !!uid,
    })
    return q.data ?? []
}

// -----------------------------------------------------------------------------
// Profile CRUD
// -----------------------------------------------------------------------------

export function useProfileActions() {
    const queryClient = useQueryClient()
    const profiles = useProfiles()
    const [activeUid, setActiveUid] = useAtom(activeProfileUidAtom)

    const invalidate = React.useCallback(() => {
        queryClient.invalidateQueries({ queryKey: [...QK_PROFILES] })
    }, [queryClient])

    const createMut = useServerMutation<Profile, { uid: string; name: string; avatar: string; color: string }>({
        endpoint: EP_CREATE,
        method: "POST",
        mutationKey: ["profiles", "create"],
        onSuccess: () => invalidate(),
    })

    const add = React.useCallback(
        async (data: { name: string; avatar: string; color: string }): Promise<Profile | null> => {
            const uid = cryptoUid()
            const created = await createMut.mutateAsync({ uid, ...data })
            return created ?? null
        },
        [createMut],
    )

    const update = React.useCallback(
        async (uid: string, patch: Partial<Pick<Profile, "name" | "avatar" | "color">>): Promise<void> => {
            const r = await fetch(EP_PATCH(uid), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            })
            if (!r.ok) throw new Error(`Profile update failed: ${r.status}`)
            invalidate()
        },
        [invalidate],
    )

    const remove = React.useCallback(
        async (uid: string): Promise<void> => {
            const r = await fetch(EP_DELETE(uid), { method: "DELETE" })
            if (!r.ok) throw new Error(`Profile delete failed: ${r.status}`)
            if (activeUid === uid) setActiveUid(null)
            invalidate()
            queryClient.invalidateQueries({ queryKey: ["profiles", uid, "history"] })
            queryClient.invalidateQueries({ queryKey: ["profiles", uid, "list"] })
        },
        [activeUid, setActiveUid, invalidate, queryClient],
    )

    const select = React.useCallback(
        (uid: string | null) => setActiveUid(uid),
        [setActiveUid],
    )

    return {
        profiles,
        activeUid,
        // Legacy alias kept for the existing UI code.
        activeId: activeUid,
        add,
        update,
        remove,
        select,
    }
}

// -----------------------------------------------------------------------------
// Watch history upsert (called every 5s by NetflixWatchHistorySaver)
// -----------------------------------------------------------------------------

/**
 * Body shape for `/api/v1/profiles/:uid/history` PUT/POST — matches the
 * backend handler exactly.
 */
export type WatchHistoryUpsertBody = {
    tmdbId: number
    mediaType: "movie" | "tv"
    season: number    // 0 for movies
    episode: number   // 0 for movies
    currentTime: number
    duration: number
    title: string
    posterPath: string
    backdropUrl: string
}

/**
 * Fire-and-forget upsert. Failures are swallowed — the next 5s tick
 * will retry, and we don't want network blips to surface as toasts
 * during playback.
 */
export async function pushProfileHistoryEntry(
    profileUid: string,
    entry: WatchHistoryUpsertBody,
): Promise<void> {
    if (!profileUid) return
    try {
        await fetch(EP_HISTORY(profileUid), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
        })
    } catch {
        // Network blip — the next tick will retry.
    }
}

/** Hook exposing a stable upsert function bound to the active profile.
 *  Performs an optimistic local update of the React Query cache before
 *  the network call so the "Reprendre la lecture" rail reflects the
 *  change instantly — no roundtrip needed before the UI re-renders. */
export function useProfileHistoryUpsert() {
    const uid = useActiveProfileId()
    const queryClient = useQueryClient()
    return React.useCallback(
        async (entry: WatchHistoryUpsertBody) => {
            if (!uid) return
            optimisticUpsertHistory(queryClient, uid, entry)
            await pushProfileHistoryEntry(uid, entry)
            // Reconcile with the server (replaces our placeholder id /
            // updatedAt with the real ones).
            queryClient.invalidateQueries({ queryKey: [...QK_HISTORY(uid)] })
        },
        [uid, queryClient],
    )
}

/**
 * Mutate the cached history list in place — moves the matching row to
 * the front (or inserts it) so the "Reprendre la lecture" rail re-sorts
 * by recency immediately.
 *
 * Uses Date.now() as a placeholder id; the next invalidate will replace
 * it with the server-assigned one.
 */
function optimisticUpsertHistory(
    qc: ReturnType<typeof useQueryClient>,
    uid: string,
    entry: WatchHistoryUpsertBody,
) {
    qc.setQueryData<ProfileWatchEntry[]>([...QK_HISTORY(uid)], (prev = []) => {
        const idx = prev.findIndex(
            e =>
                e.tmdbId === entry.tmdbId &&
                e.mediaType === entry.mediaType &&
                e.season === entry.season &&
                e.episode === entry.episode,
        )
        const existing = idx >= 0 ? prev[idx] : null
        const optimistic: ProfileWatchEntry = {
            id: existing?.id ?? Date.now(),
            profileUid: uid,
            tmdbId: entry.tmdbId,
            mediaType: entry.mediaType,
            season: entry.season,
            episode: entry.episode,
            currentTime: entry.currentTime,
            duration: entry.duration,
            title: entry.title,
            posterPath: entry.posterPath,
            backdropUrl: entry.backdropUrl,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }
        const without = idx >= 0 ? [...prev.slice(0, idx), ...prev.slice(idx + 1)] : prev
        // Most-recent first — matches the backend's ORDER BY updatedAt
        // DESC, so the rail re-sort happens locally without a refetch.
        return [optimistic, ...without]
    })
}

// -----------------------------------------------------------------------------
// Watch history delete actions
// -----------------------------------------------------------------------------

/**
 * Two flavours of history removal:
 *   - deleteByMedia(tmdbId, mediaType)   removes all rows for that title
 *                                        (every season/episode of a series)
 *   - clearAll()                         wipes the whole profile's history
 */
export function useProfileHistoryActions() {
    const uid = useActiveProfileId()
    const queryClient = useQueryClient()

    const invalidate = React.useCallback(() => {
        if (!uid) return
        queryClient.invalidateQueries({ queryKey: [...QK_HISTORY(uid)] })
    }, [uid, queryClient])

    const deleteByMedia = React.useCallback(
        async (tmdbId: number, mediaType: "movie" | "tv") => {
            if (!uid) return
            // Optimistic local removal — rail / lists page reflect the
            // change without waiting for the DELETE.
            queryClient.setQueryData<ProfileWatchEntry[]>(
                [...QK_HISTORY(uid)],
                (prev = []) =>
                    prev.filter(e => !(e.tmdbId === tmdbId && e.mediaType === mediaType)),
            )
            await fetch(`${EP_HISTORY(uid)}/${mediaType}/${tmdbId}`, { method: "DELETE" })
            invalidate()
        },
        [uid, invalidate, queryClient],
    )

    const clearAll = React.useCallback(async () => {
        if (!uid) return
        queryClient.setQueryData<ProfileWatchEntry[]>([...QK_HISTORY(uid)], [])
        await fetch(EP_HISTORY(uid), { method: "DELETE" })
        invalidate()
    }, [uid, invalidate, queryClient])

    return { deleteByMedia, clearAll }
}

// -----------------------------------------------------------------------------
// Per-profile list ("Mes listes")
// -----------------------------------------------------------------------------

export function useActiveProfileList(): ProfileListEntry[] {
    const uid = useActiveProfileId()
    const q = useServerQuery<ProfileListEntry[]>({
        endpoint: uid ? EP_PROFILE_LIST(uid) : "",
        method: "GET",
        queryKey: uid ? [...QK_PROFILE_LIST(uid)] : ["profiles", "list", "noop"],
        enabled: !!uid,
    })
    return q.data ?? []
}

/**
 * Key used by the modal / cards to ask "is this title in my list, and at
 * what status?" Composite key because TMDB IDs collide between movies
 * and TV (a movie with id 1399 is unrelated to a TV show with id 1399).
 */
export function listEntryKey(mediaType: "movie" | "tv", tmdbId: number): string {
    return `${mediaType}:${tmdbId}`
}

/** Map ("movie:123" | "tv:456") → status for O(1) lookup. */
export function useActiveProfileListStatusMap(): Map<string, ProfileListStatus> {
    const list = useActiveProfileList()
    return React.useMemo(() => {
        const m = new Map<string, ProfileListStatus>()
        for (const e of list) m.set(listEntryKey(e.mediaType, e.tmdbId), e.status)
        return m
    }, [list])
}

export function useProfileListActions() {
    const uid = useActiveProfileId()
    const queryClient = useQueryClient()

    const invalidate = React.useCallback(() => {
        if (!uid) return
        queryClient.invalidateQueries({ queryKey: [...QK_PROFILE_LIST(uid)] })
    }, [uid, queryClient])

    const upsert = React.useCallback(
        async (entry: {
            tmdbId: number
            mediaType: "movie" | "tv"
            status: ProfileListStatus
            title: string
            posterPath: string
        }): Promise<void> => {
            if (!uid) return
            // Optimistic local upsert.
            queryClient.setQueryData<ProfileListEntry[]>(
                [...QK_PROFILE_LIST(uid)],
                (prev = []) => {
                    const idx = prev.findIndex(
                        e => e.tmdbId === entry.tmdbId && e.mediaType === entry.mediaType,
                    )
                    const existing = idx >= 0 ? prev[idx] : null
                    const optimistic: ProfileListEntry = {
                        id: existing?.id ?? Date.now(),
                        profileUid: uid,
                        tmdbId: entry.tmdbId,
                        mediaType: entry.mediaType,
                        status: entry.status,
                        title: entry.title,
                        posterPath: entry.posterPath,
                        createdAt: existing?.createdAt ?? new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    }
                    if (idx >= 0) {
                        const next = [...prev]
                        next[idx] = optimistic
                        return next
                    }
                    return [optimistic, ...prev]
                },
            )
            await fetch(EP_PROFILE_LIST(uid), {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(entry),
            })
            invalidate()
        },
        [uid, invalidate, queryClient],
    )

    const remove = React.useCallback(
        async (tmdbId: number, mediaType: "movie" | "tv"): Promise<void> => {
            if (!uid) return
            queryClient.setQueryData<ProfileListEntry[]>(
                [...QK_PROFILE_LIST(uid)],
                (prev = []) =>
                    prev.filter(e => !(e.tmdbId === tmdbId && e.mediaType === mediaType)),
            )
            await fetch(`${EP_PROFILE_LIST(uid)}/${mediaType}/${tmdbId}`, {
                method: "DELETE",
            })
            invalidate()
        },
        [uid, invalidate, queryClient],
    )

    return { upsert, remove }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function cryptoUid(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID()
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
