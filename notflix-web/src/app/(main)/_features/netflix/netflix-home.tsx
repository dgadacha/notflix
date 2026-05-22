import { NetflixContinueWatching } from "@/app/(main)/_features/netflix/netflix-continue-watching"
import { NetflixHero } from "@/app/(main)/_features/netflix/netflix-hero"
import { NetflixRow } from "@/app/(main)/_features/netflix/netflix-row"
import { useActiveProfileHistory } from "@/lib/profiles/profiles"
import { useDiscover, useTMDBRecommendations, useTrending } from "@/lib/tmdb"
import React from "react"
import { useTranslation } from "react-i18next"

/**
 * Notflix home — hero + a stack of TMDB-fed rows.
 *
 * The endpoints are all served by our local Go proxy at /api/v1/tmdb, so the
 * TMDB API key never leaves the backend. Each row owns its own query so they
 * fetch in parallel and can fail independently.
 */
export function NetflixHome() {
    return (
        <div data-netflix-home className="contents">
            {/* Hero opts out of the route's top padding so it sits flush under
                the transparent navbar — Netflix-style. */}
            <div className="-mt-16 lg:-mt-[68px]">
                <NetflixHero />
            </div>

            <div className="relative z-[2] mt-4 space-y-10 pb-20">
                {/* Rendered above trending so a returning user lands on
                    their resume picks. Empty-state friendly — the
                    component returns null when there's no in-progress
                    history. */}
                <NetflixContinueWatching />
                {/* Self-contained personalised row — picks the most-
                    recently-watched entry from the active profile,
                    asks TMDB for recommendations, renders or returns
                    null. Hidden if no profile / no history. */}
                <BecauseYouWatchedRow />
                <TrendingMoviesRow />
                <PopularMoviesRow />
                <TopRatedMoviesRow />
                <NowPlayingMoviesRow />
                <TrendingTVRow />
                <PopularTVRow />
                <UpcomingMoviesRow />
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Movie rows
// ---------------------------------------------------------------------------

function TrendingMoviesRow() {
    const { t } = useTranslation()
    const { data, isLoading } = useTrending("movie", "week")
    return (
        <NetflixRow
            title={t("home.rows.trending_movies", "Films tendance")}
            media={data?.results}
            isLoading={isLoading}
            priorityImages
            fallbackType="movie"
        />
    )
}

function PopularMoviesRow() {
    const { t } = useTranslation()
    const { data, isLoading } = useDiscover("/movie/popular")
    return (
        <NetflixRow
            title={t("home.rows.popular_movies", "Films populaires")}
            media={data?.results}
            isLoading={isLoading}
            fallbackType="movie"
        />
    )
}

function TopRatedMoviesRow() {
    const { t } = useTranslation()
    const { data, isLoading } = useDiscover("/movie/top_rated")
    return (
        <NetflixRow
            title={t("home.rows.top_rated_movies", "Films les mieux notés")}
            media={data?.results}
            isLoading={isLoading}
            fallbackType="movie"
        />
    )
}

function NowPlayingMoviesRow() {
    const { t } = useTranslation()
    const { data, isLoading } = useDiscover("/movie/now_playing")
    return (
        <NetflixRow
            title={t("home.rows.now_playing", "Au cinéma en ce moment")}
            media={data?.results}
            isLoading={isLoading}
            fallbackType="movie"
        />
    )
}

function UpcomingMoviesRow() {
    const { t } = useTranslation()
    const { data, isLoading } = useDiscover("/movie/upcoming")
    return (
        <NetflixRow
            title={t("home.rows.upcoming_movies", "Bientôt en salles")}
            media={data?.results}
            isLoading={isLoading}
            fallbackType="movie"
        />
    )
}

// ---------------------------------------------------------------------------
// TV rows
// ---------------------------------------------------------------------------

function TrendingTVRow() {
    const { t } = useTranslation()
    const { data, isLoading } = useTrending("tv", "week")
    return (
        <NetflixRow
            title={t("home.rows.trending_tv", "Séries tendance")}
            media={data?.results}
            isLoading={isLoading}
            fallbackType="tv"
        />
    )
}

function PopularTVRow() {
    const { t } = useTranslation()
    const { data, isLoading } = useDiscover("/tv/popular")
    return (
        <NetflixRow
            title={t("home.rows.popular_tv", "Séries populaires")}
            media={data?.results}
            isLoading={isLoading}
            fallbackType="tv"
        />
    )
}

// ---------------------------------------------------------------------------
// Personalised row — "Parce que tu as regardé X"
// ---------------------------------------------------------------------------

/** Pulls the active profile's most-recently-watched entry and shows
 *  TMDB recommendations for that title. Returns null when:
 *   - no active profile
 *   - empty history
 *   - TMDB has no recommendations for the pick (very rare — most
 *     titles have at least a handful)
 *
 *  The "watched" pick honours a small tweak: when the most recent
 *  entry is a single TV episode S01E01 the user just started, we
 *  still recommend off the SERIES id (not the episode), so the row is
 *  meaningful from the very first play. */
function BecauseYouWatchedRow() {
    const { t } = useTranslation()
    const history = useActiveProfileHistory()
    // Most recent entry wins. The history is already sorted desc by
    // updatedAt on the backend, but defend against shape changes.
    const recent = React.useMemo(() => {
        if (!history || history.length === 0) return null
        return [...history].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )[0]
    }, [history])

    const { data, isLoading } = useTMDBRecommendations(
        recent ? recent.mediaType : null,
        recent ? recent.tmdbId : null,
    )

    if (!recent) return null
    // Filter out the watched title from its own recommendations row
    // (TMDB sometimes includes the original — looks weird).
    const filtered = (data?.results ?? []).filter(m => m.id !== recent.tmdbId)
    if (!isLoading && filtered.length === 0) return null

    return (
        <NetflixRow
            title={t("home.rows.because_you_watched", "Parce que tu as regardé {{title}}", { title: recent.title })}
            media={filtered}
            isLoading={isLoading}
            fallbackType={recent.mediaType}
        />
    )
}
