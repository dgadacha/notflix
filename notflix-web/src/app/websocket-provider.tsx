/**
 * Notflix websocket provider — stub.
 *
 * Seanime had a long-lived websocket to push events from the backend
 * (scanner progress, torrent stream state, plugin tray, etc). Notflix is
 * pure request/response — TMDB lookups, TorBox magnet → URL, Prowlarr
 * search — and doesn't need a persistent socket. This file exists so the
 * existing client-providers wiring keeps working.
 */
import { atom } from "jotai"
import React from "react"

export const websocketConnectedAtom = atom(true)

export function WebsocketProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>
}
