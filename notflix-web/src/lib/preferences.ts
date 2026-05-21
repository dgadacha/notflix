/**
 * User playback preferences — persisted in localStorage, applied as a
 * filter on the Prowlarr release list at /watch.
 *
 * "auto" lets the backend's score (cached × seeders × quality bonus)
 * pick freely. Any other value restricts the candidates BEFORE the
 * auto-pick runs.
 */
import { atom, useAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"

export type QualityPref = "auto" | "4k" | "1080p" | "720p" | "sd"
export type AudioPref = "auto" | "fr" | "vo"

export const QUALITY_OPTIONS: { value: QualityPref; label: string }[] = [
    { value: "auto", label: "Auto (meilleure dispo)" },
    { value: "4k", label: "4K / 2160p" },
    { value: "1080p", label: "1080p" },
    { value: "720p", label: "720p" },
    { value: "sd", label: "SD" },
]

export const AUDIO_OPTIONS: { value: AudioPref; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "fr", label: "Français (VFF / Multi)" },
    { value: "vo", label: "Version originale" },
]

export const qualityPrefAtom = atomWithStorage<QualityPref>("notflix-pref-quality", "auto")
export const audioPrefAtom = atomWithStorage<AudioPref>("notflix-pref-audio", "auto")

export function useQualityPref() {
    return useAtom(qualityPrefAtom)
}

export function useAudioPref() {
    return useAtom(audioPrefAtom)
}

/**
 * Pure helpers — also used by /watch to filter the release list with the
 * exact same logic as the badges shown in the modal/picker.
 */
export function releaseMatchesQuality(quality: string, pref: QualityPref): boolean {
    if (pref === "auto") return true
    const q = quality.toLowerCase()
    switch (pref) {
        case "4k":
            return q === "4k"
        case "1080p":
            return q === "1080p"
        case "720p":
            return q === "720p"
        case "sd":
            return q === "sd"
    }
}

const FR_TOKENS = ["french", "multi", "vff", "truefrench", "vf "]

export function releaseHasFrenchAudio(title: string): boolean {
    const t = title.toLowerCase()
    return FR_TOKENS.some(tok => t.includes(tok))
}

export function releaseMatchesAudio(title: string, pref: AudioPref): boolean {
    if (pref === "auto") return true
    const isFrench = releaseHasFrenchAudio(title)
    return pref === "fr" ? isFrench : !isFrench
}

/**
 * Audio codecs that Chrome can't decode (Safari can — Apple has the
 * Dolby licence — but Notflix's typical user is on Chrome). Releases
 * tagged with one of these play the video silently and the volume
 * control is greyed out. The release picker filters them out unless
 * nothing else is available.
 */
const INCOMPATIBLE_AUDIO_TOKENS = [
    "ddp",      // Dolby Digital Plus (DDP2.0, DDP5.1)
    "dd+",      // Alternative spelling
    "eac3",     // Enhanced AC-3
    "e-ac3",
    "e-ac-3",
    "dts",      // DTS Core / DTS-HD / DTS-X
    "truehd",   // Dolby TrueHD
    "atmos",    // Dolby Atmos (usually muxed on top of TrueHD or EAC3)
]

export function releaseHasIncompatibleAudio(title: string): boolean {
    const t = title.toLowerCase()
    return INCOMPATIBLE_AUDIO_TOKENS.some(tok => t.includes(tok))
}
