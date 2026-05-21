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
 * Audio codecs the browser may or may not decode. Browser support depends
 * on the OS-provided decoders:
 *
 *   - Safari (macOS / iOS): Apple has the Dolby licence → AC-3 + E-AC-3
 *     + TrueHD all work.
 *   - Chrome on macOS (≥ 116): often inherits the Apple decoders,
 *     E-AC-3 works.
 *   - Chrome on Linux / Windows: no Dolby decoders → silent playback.
 *   - DTS: not licensed in any major browser, never works.
 *
 * Rather than a hard blacklist, we ask the browser via canPlayType()
 * which codecs it admits to supporting. Releases that mention an audio
 * tag the browser CAN handle stay in the picker; the rest are filtered.
 *
 * If a release tag isn't in the test list (older AC-3, plain "AAC", …)
 * we treat it as compatible — those are the universally-supported codecs.
 */
type CodecToken = "ac3" | "ddp" | "dd+" | "eac3" | "e-ac3" | "e-ac-3" | "dts" | "truehd" | "atmos"

const CODEC_PROBES: { token: CodecToken; mimes: string[] }[] = [
    { token: "ac3", mimes: ['audio/mp4; codecs="ac-3"', 'audio/ac3'] },
    { token: "ddp", mimes: ['audio/mp4; codecs="ec-3"'] },
    { token: "dd+", mimes: ['audio/mp4; codecs="ec-3"'] },
    { token: "eac3", mimes: ['audio/mp4; codecs="ec-3"'] },
    { token: "e-ac3", mimes: ['audio/mp4; codecs="ec-3"'] },
    { token: "e-ac-3", mimes: ['audio/mp4; codecs="ec-3"'] },
    { token: "dts", mimes: ['audio/vnd.dts', 'audio/vnd.dts.hd'] },
    { token: "truehd", mimes: ['audio/vnd.dolby.mlp'] },
    // Atmos in MKV is usually muxed on top of TrueHD (lossless) or E-AC-3
    // (lossy fallback). If either of those work, atmos plays — the
    // browser will fall back to the embedded core track.
    { token: "atmos", mimes: ['audio/vnd.dolby.mlp', 'audio/mp4; codecs="ec-3"'] },
]

let _supportedCodecsCache: Set<CodecToken> | undefined

function detectSupportedAudioCodecs(): Set<CodecToken> {
    if (_supportedCodecsCache) return _supportedCodecsCache
    const supported = new Set<CodecToken>()
    if (typeof document === "undefined") {
        _supportedCodecsCache = supported
        return supported
    }
    const v = document.createElement("video")
    for (const { token, mimes } of CODEC_PROBES) {
        // canPlayType returns "probably", "maybe" or "". Only "probably"
        // is a real yes — "maybe" is the browser hedging on container
        // compatibility, often a lie for the audio side.
        if (mimes.some(m => v.canPlayType(m) === "probably")) {
            supported.add(token)
        }
    }
    _supportedCodecsCache = supported
    return supported
}

/**
 * True iff the release name signals an audio codec THIS browser can't
 * decode. Releases that mention a codec the browser does support — or
 * no exotic codec at all (assumed AAC/AC-3 default) — pass through.
 */
export function releaseHasIncompatibleAudio(title: string): boolean {
    const t = title.toLowerCase()
    const supported = detectSupportedAudioCodecs()
    for (const { token } of CODEC_PROBES) {
        if (t.includes(token) && !supported.has(token)) {
            return true
        }
    }
    return false
}
