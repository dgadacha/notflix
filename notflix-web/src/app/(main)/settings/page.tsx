/**
 * Notflix settings — placeholder.
 *
 * The Seanime settings UI was full of anime/library/torrent-client config
 * that doesn't apply here (TMDB + TorBox + Prowlarr are environment-config
 * server-side). Phase 4 will surface what's actually configurable: profile
 * defaults, language, audio-track preference (FR vs EN), etc.
 */
import React from "react"
import { useTranslation } from "react-i18next"

export default function SettingsPage() {
    const { t } = useTranslation()
    return (
        <div className="px-4 sm:px-6 lg:px-16 py-12 lg:py-20 space-y-6 max-w-3xl mx-auto text-center">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                {t("nav.settings", "Paramètres")}
            </h1>
            <p className="text-[--muted]">
                {t("settings.coming_soon", "Bientôt disponible. La configuration de Notflix (TMDB, TorBox, Prowlarr) se fait pour l'instant via les variables d'environnement du backend.")}
            </p>
        </div>
    )
}
