import { AL_AnimeDetailsById_Media, AL_BaseAnime, Nullish } from "@/api/generated/types"
import { NetflixCard } from "@/app/(main)/_features/netflix/netflix-card"
import React from "react"
import { useTranslation } from "react-i18next"

type Props = {
    details: Nullish<AL_AnimeDetailsById_Media>
}

/**
 * Replaces the seanime "Relations + Recommendations + Characters" stack
 * with a single Netflix-style "More like this" grid. Falls back silently
 * when AniList returned no recommendations.
 */
export function NetflixMoreLikeThis({ details }: Props) {
    const { t } = useTranslation()

    const items = React.useMemo<AL_BaseAnime[]>(() => {
        const rec = details?.recommendations?.edges
            ?.map(e => e?.node?.mediaRecommendation)
            .filter(Boolean) ?? []
        return rec as AL_BaseAnime[]
    }, [details])

    if (items.length === 0) return null

    return (
        <section className="px-6 lg:px-16 pb-16 space-y-4">
            <h2 className="text-xl lg:text-2xl font-bold text-white tracking-tight">
                {t("entry.more_like_this")}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6 py-2">
                {items.slice(0, 10).map(m => (
                    <NetflixCard key={m.id} media={m} variant="grid" />
                ))}
            </div>
        </section>
    )
}
