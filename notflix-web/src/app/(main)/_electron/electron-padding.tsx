/**
 * Electron padding — pure no-op for the web build. The Seanime app-layout
 * imports this to add titlebar spacing on the desktop client; Notflix is
 * web-only.
 */
import React from "react"

export function ElectronPadding({ children }: { children?: React.ReactNode }) {
    return <>{children}</>
}

/** macOS traffic-light spacer in the sidebar — no-op on the web. */
export function ElectronSidebarPaddingMacOS() {
    return null
}

export function useElectronPadding() {
    return 0
}
