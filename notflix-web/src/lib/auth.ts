/**
 * Auth client — login, logout, current user, and the admin-only child
 * account CRUD. Sessions live in HttpOnly cookies set by the Go backend;
 * the frontend never touches the token directly.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

export type CurrentUser = {
    id: number
    username: string
    displayName: string
    isAdmin: boolean
    createdAt: string
}

type LoginBody = { username: string; password: string }
type CreateUserBody = {
    username: string
    password: string
    displayName?: string
    isAdmin?: boolean
}

const QK_ME = ["auth", "me"] as const
const QK_USERS = ["users"] as const

// --------------------------------------------------------------------------
// Current user / session lifecycle
// --------------------------------------------------------------------------

export function useCurrentUser() {
    return useQuery<CurrentUser | null>({
        queryKey: [...QK_ME],
        queryFn: async () => {
            const r = await fetch("/api/v1/auth/me")
            // 401 = anonymous. Return null so the layout can render the
            // login screen without React Query treating it as an error
            // and retrying forever.
            if (r.status === 401) return null
            if (!r.ok) throw new Error(`auth/me ${r.status}`)
            const j = await r.json()
            return (j.data as CurrentUser) ?? null
        },
        retry: false,
        staleTime: 5 * 60_000,
    })
}

export function useLogin() {
    const qc = useQueryClient()
    return useMutation<CurrentUser, Error, LoginBody>({
        mutationFn: async (body) => {
            const r = await fetch("/api/v1/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            if (!r.ok) {
                const j = (await r.json().catch(() => ({}))) as { error?: string }
                throw new Error(j.error || "Identifiants invalides")
            }
            const j = await r.json()
            return j.data as CurrentUser
        },
        onSuccess: (user) => {
            qc.setQueryData([...QK_ME], user)
        },
    })
}

export function useLogout() {
    return useMutation<boolean, Error, void>({
        mutationFn: async () => {
            await fetch("/api/v1/auth/logout", { method: "POST" })
            return true
        },
        onSuccess: () => {
            // Hard reload after logout — gives us three things at once:
            //   1. Bulletproof state reset: React Query cache, jotai
            //      atoms, in-memory hls.js instances, everything goes
            //      back to defaults. No risk of the previous user's
            //      profile / history leaking into the next session.
            //   2. No timing fragility: relying on qc.clear() + a
            //      single render pass to swap MainLayout → NetflixLogin
            //      was flaky in practice (observers weren't always
            //      notified before the next paint).
            //   3. Cookie state lines up with the freshly-rendered
            //      app — no half-second window where the layout still
            //      thinks the user is authed.
            window.location.href = "/"
        },
    })
}

// --------------------------------------------------------------------------
// Admin: child user CRUD
// --------------------------------------------------------------------------

export function useUsers() {
    return useQuery<CurrentUser[]>({
        queryKey: [...QK_USERS],
        queryFn: async () => {
            const r = await fetch("/api/v1/users")
            if (!r.ok) throw new Error(`users ${r.status}`)
            const j = await r.json()
            return (j.data as CurrentUser[]) ?? []
        },
    })
}

export function useCreateUser() {
    const qc = useQueryClient()
    return useMutation<CurrentUser, Error, CreateUserBody>({
        mutationFn: async (body) => {
            const r = await fetch("/api/v1/users", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            if (!r.ok) {
                const j = (await r.json().catch(() => ({}))) as { error?: string }
                throw new Error(j.error || "Création impossible")
            }
            const j = await r.json()
            return j.data as CurrentUser
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: [...QK_USERS] })
        },
    })
}

export function useDeleteUser() {
    const qc = useQueryClient()
    return useMutation<boolean, Error, number>({
        mutationFn: async (id) => {
            const r = await fetch(`/api/v1/users/${id}`, { method: "DELETE" })
            if (!r.ok) {
                const j = (await r.json().catch(() => ({}))) as { error?: string }
                throw new Error(j.error || "Suppression impossible")
            }
            return true
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: [...QK_USERS] })
        },
    })
}

export function useResetUserPassword() {
    return useMutation<boolean, Error, { id: number; password: string }>({
        mutationFn: async ({ id, password }) => {
            const r = await fetch(`/api/v1/users/${id}/password`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
            })
            if (!r.ok) throw new Error("Réinitialisation impossible")
            return true
        },
    })
}
