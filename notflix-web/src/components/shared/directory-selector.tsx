/**
 * DirectorySelector — stub.
 *
 * Seanime opened a server-driven filesystem picker (anime library root etc.).
 * Notflix has no local filesystem domain, so the picker is now a passive
 * text input. The form fields wrapper feeds in whatever string the caller
 * persists.
 */
import React from "react"

export type DirectorySelectorProps = {
    value?: string
    onChange?: (value: string) => void
    onBlur?: () => void
    disabled?: boolean
    error?: string
    label?: string
    help?: string
    required?: boolean
    name?: string
    prefix?: string
    rightAddon?: React.ReactNode
    placeholder?: string
}

export function DirectorySelector(props: DirectorySelectorProps) {
    return (
        <input
            type="text"
            value={props.value ?? ""}
            onChange={(e) => props.onChange?.(e.target.value)}
            onBlur={props.onBlur}
            disabled={props.disabled}
            placeholder={props.placeholder}
            name={props.name}
            className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-md text-white placeholder:text-[--muted]"
        />
    )
}
