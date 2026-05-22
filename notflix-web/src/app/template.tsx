/**
 * Root template — wraps everything inside the router. For Notflix this is
 * essentially a passthrough; the original Seanime version handled Electron
 * window chrome and a "Connecting…" spinner tied to the websocket.
 */
import React from "react"

export default function Template({ children }: { children: React.ReactNode }) {
    return <>{children}</>
}
