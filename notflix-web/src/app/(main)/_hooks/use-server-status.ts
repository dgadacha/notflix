/**
 * Stubbed Seanime server-status hooks.
 *
 * Notflix has no password gate and no "feature disabled" flags surfaced to
 * the client; the backend just answers requests or doesn't. These hooks
 * mirror the original signatures so files we haven't migrated yet can keep
 * importing them.
 */
import { serverStatusAtom, ServerStatus } from "@/app/(main)/_atoms/server-status.atoms"
import { useAtom, useAtomValue } from "jotai"
import React from "react"

export function useServerStatus(): ServerStatus | null {
    return useAtomValue(serverStatusAtom)
}

export function useSetServerStatus() {
    const [, setStatus] = useAtom(serverStatusAtom)
    return React.useCallback((status: ServerStatus | null) => setStatus(status), [setStatus])
}

/** No simulated user, no AniList account — always null. */
export function useCurrentUser(): null {
    return null
}

/** Notflix has no disabled-feature gating; every feature is on. */
export function useServerDisabledFeatures(): string[] {
    return []
}
