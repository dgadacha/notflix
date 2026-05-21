import { NetflixContinueWatching } from "@/app/(main)/_features/netflix/netflix-continue-watching"
import { NetflixHero } from "@/app/(main)/_features/netflix/netflix-hero"
import { NetflixRow } from "@/app/(main)/_features/netflix/netflix-row"
import { useDiscover, useTrending } from "@/lib/tmdb"
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
