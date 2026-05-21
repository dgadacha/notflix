import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

export const __onlinestream_selectedProviderAtom = atomWithStorage<string | null>("sea-onlinestream-provider", null)

export const __onlinestream_selectedDubbedAtom = atom<boolean>(false)

// Variable used for the episode source query
export const __onlinestream_selectedEpisodeNumberAtom = atom<number | null>(null)

export const __onlinestream_selectedServerAtom = atomWithStorage<string | undefined>("sea-onlinestream-server", undefined)

export const __onlinestream_qualityAtom = atomWithStorage<string | undefined>("sea-onlinestream-quality", undefined)

// Set by /watch when opening a "Continue watching" link. Consumed once by
// the OnlinestreamPage on first onLoadedMetadata to seek the player.
export const __onlinestream_resumeAtSecondsAtom = atom<number | null>(null)
