/**
 * Server status atoms — minimal stubs.
 *
 * Notflix doesn't surface a server status panel; auth is open (the Cloudflare
 * Tunnel + Cloudflare Access can be layered on top instead of an in-app
 * password). These atoms exist so legacy imports keep working.
 */
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

export const SERVER_AUTH_TOKEN_STORAGE_KEY = "notflix-server-auth-token"

export const serverAuthTokenAtom = atomWithStorage<string | null>(SERVER_AUTH_TOKEN_STORAGE_KEY, null)

/** Bare-bones server status — `isOffline` only, since the layout consults it. */
export type ServerStatus = {
    isOffline?: boolean
    serverHasPassword?: boolean
    debridSettings?: { enabled?: boolean; provider?: string }
    settings?: { nakama?: { enabled?: boolean } }
    themeSettings?: Record<string, unknown> | null
}

export const serverStatusAtom = atom<ServerStatus | null>({ isOffline: false })

export const isLoginModalOpenAtom = atom(false)
