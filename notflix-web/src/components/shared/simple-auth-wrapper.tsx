/**
 * SimpleAuthWrapper — pass-through stub for Notflix.
 *
 * Seanime gated public routes (issue-report etc.) behind a server-status
 * password check. Notflix has no in-app password — auth, if any, is
 * provided by Cloudflare Access at the tunnel layer.
 */
import React from "react"

type SimpleAuthWrapperProps = {
    children?: React.ReactNode
}

export function SimpleAuthWrapper({ children }: SimpleAuthWrapperProps) {
    return <>{children}</>
}
