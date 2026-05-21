/**
 * Notflix watch page — placeholder.
 *
 * Phase 3d will replace this with the real pipeline:
 *   1. Parse ?id=<tmdb-id>&type=<movie|tv>[&season=&episode=] from the URL
 *   2. Fetch the TMDB detail to derive title + year
 *   3. Call `/api/v1/prowlarr/search/{movie|tv}` → release list with cache flags
 *   4. User picks a release (or the auto-best wins) → POST `/api/v1/torbox/play`
 *      with the magnet → resolves to a direct stream URL
 *   5. Mount a native `<video>` element on that URL with controls + PiP-on-blur
 */
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useSearchParams } from "@/lib/navigation"
import { titleOf, tmdbImage, useTMDBDetail, yearOf } from "@/lib/tmdb"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiPlay } from "react-icons/bi"

export default function WatchPage() {
    const { t } = useTranslation()
    const searchParams = useSearchParams()
    const idParam = searchParams.get("id")
    const typeParam = (searchParams.get("type") as "movie" | "tv" | null) ?? "movie"

    const mediaId = idParam ? parseInt(idParam, 10) : NaN
    const { data, isLoading } = useTMDBDetail(typeParam, Number.isNaN(mediaId) ? null : mediaId)

    if (Number.isNaN(mediaId)) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center text-[--muted]">
                Missing or invalid <code className="mx-1 px-1.5 py-0.5 bg-white/10 rounded">id</code> query param.
            </div>
        )
    }

    const banner = tmdbImage("original", data?.backdrop_path) || tmdbImage("w780", data?.poster_path)
    const title = data ? titleOf(data) : ""
    const year = data ? yearOf(data) : ""

    return (
        <div data-watch-splash className="min-h-screen bg-black -mt-16 lg:-mt-[68px] relative overflow-hidden">
            {banner && (
                <img
                    src={banner}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover object-center opacity-50"
                />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/30" />

            <div className="relative z-[1] min-h-screen flex flex-col items-center justify-center px-6 text-center gap-6">
                <p className="uppercase tracking-widest text-xs lg:text-sm text-brand-400 font-semibold">
                    {typeParam === "tv" ? t("watch.tv_short", "Série") : t("watch.movie_short", "Film")} {year && `· ${year}`}
                </p>
                {isLoading ? (
                    <Skeleton className="h-12 w-80 max-w-full" />
                ) : (
                    <h1 className="text-3xl lg:text-5xl font-extrabold text-white max-w-3xl drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
                        {title || "Notflix"}
                    </h1>
                )}

                <Button
                    size="xl"
                    leftIcon={<BiPlay className="text-3xl" />}
                    className="bg-white !text-black hover:!bg-white/90 font-bold px-10 rounded-md mt-4"
                    disabled
                >
                    {t("watch.coming_soon", "Lecture (bientôt)")}
                </Button>

                <p className="text-xs text-[--muted] max-w-md mt-2">
                    {t("watch.placeholder_hint", "Le lecteur Prowlarr → TorBox est en cours d'intégration. Vous pourrez bientôt lancer ce titre depuis cette page.")}
                </p>
            </div>
        </div>
    )
}
