/**
 * Offline layout — kept as a tiny stub for now.
 *
 * Notflix is a server-backed app (TMDB + TorBox + Prowlarr all live remote),
 * so "offline" doesn't really apply the way it did for Seanime's local
 * library mode. This component is here only so legacy imports don't break.
 */
import React from "react"

export function OfflineLayout({ children }: { children?: React.ReactNode }) {
    return <>{children}</>
}
