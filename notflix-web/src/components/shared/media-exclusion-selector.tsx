/**
 * MediaExclusionSelector — stub.
 *
 * In Seanime this was a picker over the AniList library, used to exclude
 * specific anime from the auto-downloader. Notflix has no library + no
 * auto-downloader, so the component is now a passive form field that just
 * stores an array of ids the caller hands it.
 */
import React from "react"

export type MediaExclusionSelectorProps = {
    value?: number[]
    onChange?: (value: number[]) => void
    onBlur?: () => void
    disabled?: boolean
    error?: string
    label?: string
    help?: string
    required?: boolean
    name?: string
}

export function MediaExclusionSelector(_props: MediaExclusionSelectorProps) {
    return null
}
