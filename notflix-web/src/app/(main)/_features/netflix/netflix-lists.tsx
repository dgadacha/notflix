/**
 * Notflix lists — placeholder while the per-profile list / history backend
 * is wired to TMDB ids. Phase 3e will restore the full tabbed view (Mes
 * listes / Vu / À voir / Abandonnés / Historique).
 */
import React from "react"
import { useTranslation } from "react-i18next"

export function NetflixLists() {
    const { t } = useTranslation()
    return (
        <div className="px-4 sm:px-6 lg:px-16 py-12 lg:py-20 space-y-6 max-w-3xl mx-auto text-center">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                {t("lists.title", "Mes listes")}
            </h1>
            <p className="text-[--muted]">
                {t("lists.coming_soon", "Cette section sera bientôt disponible. En attendant, utilisez la recherche pour trouver un film ou une série, puis l'icône « Ajouter à ma liste » sur sa fiche.")}
            </p>
        </div>
    )
}
