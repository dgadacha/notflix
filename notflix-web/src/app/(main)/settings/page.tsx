/**
 * /settings — Netflix-style preferences page.
 *
 * The original Seanime page had a tab-heavy form (anime library, torrent
 * client, AniList, Nakama, …) that doesn't apply to Notflix. The Notflix
 * page is a flat list of sections: account, playback prefs, language,
 * profiles, admin shortcut, about. Server-side config (TMDB / TorBox /
 * Prowlarr keys) stays in environment variables — not editable from the
 * UI on purpose so a child user can't break the catalogue.
 */
import { NetflixSettings } from "@/app/(main)/_features/netflix/netflix-settings"
import React from "react"

export default function SettingsPage() {
    return <NetflixSettings />
}
