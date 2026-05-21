/**
 * Notflix watch page — TMDB → Prowlarr → TorBox → native <video>.
 *
 * UX is one-click: arriving here the page immediately searches Prowlarr,
 * auto-picks the top release (backend already ranked by cached → score →
 * seeders) and hands it to TorBox. The picker still exists as an
 * escape hatch — a "Changer de source" button surfaces it from the
 * preparing/playing phases.
 *
 * Phases:
 *
 *   searching   Hitting /api/v1/prowlarr/search/{movie|tv}; spinner.
 *   picking     Manual release selection (entered only via "Changer
 *               de source" or when auto-pick failed).
 *   preparing   POST /api/v1/torbox/play. Can take up to 3 min on a
 *               non-cached torrent — the UI copy says so.
 *   playing     Native <video> mounted on the resolved URL. PiP-on-blur
 *               kicks in so the player keeps going if the user tabs away.
 *   error       Surfaced + retry / change-source.
 */
import { Release, TorBoxPlayBody, useSearchMovie, useSearchTV, useTorBoxPlay } from "@/lib/notflix-api"
import {
    AudioPref,
    QualityPref,
    releaseHasFrenchAudio,
    releaseMatchesAudio,
    releaseMatchesQuality,
} from "@/lib/preferences"
import { titleOf, tmdbImage, useTMDBDetail, yearOf } from "@/lib/tmdb"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { useRouter, useSearchParams } from "@/lib/navigation"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiArrowBack, BiPlay, BiRefresh, BiSolidCheckCircle } from "react-icons/bi"
import { FiLoader } from "react-icons/fi"

type Phase = "searching" | "picking" | "preparing" | "playing" | "error"

export default function WatchPage() {
    const { t } = useTranslation()
    const router = useRouter()
    const searchParams = useSearchParams()
    const idParam = searchParams.get("id")
    const typeParam = (searchParams.get("type") as "movie" | "tv" | null) ?? "movie"
    const seasonParam = searchParams.get("season")
    const episodeParam = searchParams.get("episode")

    const mediaId = idParam ? parseInt(idParam, 10) : NaN
    const season = seasonParam ? parseInt(seasonParam, 10) : undefined
    const episode = episodeParam ? parseInt(episodeParam, 10) : undefined

    // Playback prefs come from the modal's selectors via the URL.
    const qualityPref = (searchParams.get("quality") as QualityPref | null) ?? "auto"
    const audioPref = (searchParams.get("audio") as AudioPref | null) ?? "auto"

    const { data: detail, isLoading: detailLoading } = useTMDBDetail(
        typeParam,
        Number.isNaN(mediaId) ? null : mediaId,
    )

    const [phase, setPhase] = React.useState<Phase>("searching")
    const [pickedRelease, setPickedRelease] = React.useState<Release | null>(null)
    const [streamUrl, setStreamUrl] = React.useState<string | null>(null)
    const [errorMsg, setErrorMsg] = React.useState<string | null>(null)
    // Lets the user opt out of the auto-pick: once they click "Changer de
    // source" we stop trying to launch the top result behind their back.
    const [autoPickDisabled, setAutoPickDisabled] = React.useState(false)

    // Reset everything when the URL's media changes. TanStack Router reuses
    // the same component instance across /watch?id=X → /watch?id=Y (the
    // route file is the same), so without an explicit reset the previously
    // picked release / stream URL / phase would leak across — we saw it
    // hand "Le Réveil de la Momie" to the player while the title above
    // already said "Super Mario Galaxy".
    React.useEffect(() => {
        setPhase("searching")
        setPickedRelease(null)
        setStreamUrl(null)
        setErrorMsg(null)
        setAutoPickDisabled(false)
    }, [mediaId, typeParam, season, episode])

    // Prowlarr searches as soon as we know the title. No splash step — the
    // user's click on "Lecture" upstream IS the user gesture; we just keep
    // moving.
    const title = detail ? titleOf(detail) : ""
    const year = detail ? Number(yearOf(detail)) : undefined
    const movieSearch = useSearchMovie(typeParam === "movie" ? title : "", year)
    const tvSearch = useSearchTV(typeParam === "tv" ? title : "", season, episode)
    const search = typeParam === "tv" ? tvSearch : movieSearch

    const play = useTorBoxPlay()

    // Apply the user's quality / audio prefs as a post-search filter. The
    // backend score still drives the ranking; we just drop everything that
    // doesn't match. If the filter wipes the list, we fall back to the
    // unfiltered set with a non-blocking warning so the user can still play.
    const filteredReleases = React.useMemo(() => {
        const all = search.data ?? []
        if (qualityPref === "auto" && audioPref === "auto") return all
        const filtered = all.filter(
            r =>
                releaseMatchesQuality(r.quality, qualityPref) &&
                releaseMatchesAudio(r.title, audioPref),
        )
        return filtered.length > 0 ? filtered : all
    }, [search.data, qualityPref, audioPref])

    // True when the user set a non-auto pref but nothing matched, so we
    // relaxed it (filteredReleases = all). Surfaced as a small banner so
    // the auto-launched release isn't surprising.
    const prefsFellBack = React.useMemo(() => {
        if (qualityPref === "auto" && audioPref === "auto") return false
        const all = search.data ?? []
        if (all.length === 0) return false
        const strict = all.filter(
            r =>
                releaseMatchesQuality(r.quality, qualityPref) &&
                releaseMatchesAudio(r.title, audioPref),
        )
        return strict.length === 0
    }, [search.data, qualityPref, audioPref])

    // The actual launch — used both by the auto-pick effect and the manual
    // ReleasePicker. Kept as a stable callback so the auto-pick effect
    // doesn't re-fire spuriously.
    const launchRelease = React.useCallback(
        async (release: Release) => {
            if (!release.magnetUrl && !release.infoHash && !release.downloadUrl) {
                setErrorMsg(t("watch.no_source", "Cette source n'est pas utilisable (ni magnet, ni .torrent)."))
                setPhase("error")
                return
            }
            setPickedRelease(release)
            setStreamUrl(null)
            setPhase("preparing")
            try {
                const payload: TorBoxPlayBody = release.magnetUrl
                    ? { magnet: release.magnetUrl }
                    : release.infoHash
                        ? {
                            magnet: `magnet:?xt=urn:btih:${release.infoHash}&dn=${encodeURIComponent(release.title)}`,
                        }
                        : { downloadUrl: release.downloadUrl }
                const result = await play.mutateAsync(payload)
                setStreamUrl(result.streamUrl)
                setPhase("playing")
            } catch (err) {
                setErrorMsg(
                    err instanceof Error
                        ? err.message
                        : t("watch.torbox_failed", "TorBox n'a pas pu préparer le flux."),
                )
                setPhase("error")
            }
        },
        [play, t],
    )

    // Auto-pick: fire the top (pref-filtered) release as soon as the search
    // resolves, unless the user has explicitly opted into manual picking.
    React.useEffect(() => {
        if (phase !== "searching") return
        if (search.isFetching) return
        if (search.isError) {
            setErrorMsg(t("watch.search_failed", "La recherche Prowlarr a échoué."))
            setPhase("error")
            return
        }
        if (filteredReleases.length === 0) {
            setErrorMsg(t("watch.no_release", "Aucune source trouvée pour ce titre."))
            setPhase("error")
            return
        }
        if (autoPickDisabled) {
            setPhase("picking")
            return
        }
        void launchRelease(filteredReleases[0])
    }, [phase, search.isFetching, search.isError, filteredReleases, autoPickDisabled, launchRelease, t])

    const handleChangeSource = React.useCallback(() => {
        setAutoPickDisabled(true)
        setStreamUrl(null)
        setErrorMsg(null)
        setPhase("picking")
    }, [])

    const handleManualPick = React.useCallback(
        (release: Release) => {
            void launchRelease(release)
        },
        [launchRelease],
    )

    const handleRetry = React.useCallback(() => {
        setErrorMsg(null)
        setPickedRelease(null)
        setStreamUrl(null)
        setAutoPickDisabled(false)
        setPhase("searching")
    }, [])

    const handleClose = React.useCallback(() => {
        // Go back to the previous page (typically the home or the lists
        // grid). If there's no history entry (player opened in a fresh tab)
        // fall back to /.
        if (window.history.length > 1) {
            router.back()
        } else {
            router.push("/")
        }
    }, [router])

    if (Number.isNaN(mediaId)) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center text-[--muted]">
                Missing or invalid <code className="mx-1 px-1.5 py-0.5 bg-white/10 rounded">id</code> query param.
            </div>
        )
    }

    const banner = tmdbImage("original", detail?.backdrop_path) || tmdbImage("w780", detail?.poster_path)
    const displayTitle = title || (detailLoading ? "" : "Notflix")
    const displayYear = detail ? yearOf(detail) : ""

    // The player phase replaces the entire chrome with a fullscreen <video>.
    if (phase === "playing" && streamUrl) {
        return (
            <Player
                src={streamUrl}
                title={displayTitle}
                releaseTitle={pickedRelease?.title ?? ""}
                onBack={handleClose}
                onChangeSource={handleChangeSource}
            />
        )
    }

    return (
        <div data-watch className="min-h-screen bg-black -mt-16 lg:-mt-[68px] relative overflow-hidden">
            {banner && (
                <img
                    src={banner}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover object-center opacity-40"
                />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/80 to-black/40" />

            {/* Close button — top-left so it doesn't fight with the bottom
                tab on mobile. */}
            <button
                type="button"
                onClick={handleClose}
                aria-label={t("watch.close", "Fermer")}
                className="absolute top-4 left-4 z-[2] p-2 rounded-full text-white bg-black/40 hover:bg-black/70"
            >
                <BiArrowBack className="size-6" />
            </button>

            <div className="relative z-[1] min-h-screen flex flex-col items-center justify-center px-4 sm:px-6 py-12 text-center gap-6">
                <p className="uppercase tracking-widest text-xs lg:text-sm text-brand-400 font-semibold">
                    {typeParam === "tv"
                        ? t("watch.tv_short", "Série")
                        : t("watch.movie_short", "Film")}
                    {displayYear && ` · ${displayYear}`}
                    {season != null && episode != null && ` · S${season}E${episode}`}
                </p>

                {detailLoading ? (
                    <Skeleton className="h-12 w-80 max-w-full" />
                ) : (
                    <h1 className="text-3xl lg:text-5xl font-extrabold text-white max-w-3xl drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
                        {displayTitle}
                    </h1>
                )}

                {phase === "searching" && (
                    <LoadingPanel
                        label={t("watch.searching", "Recherche des sources...")}
                        sublabel={t(
                            "watch.searching_hint",
                            "Notflix interroge Prowlarr et vérifie le cache TorBox.",
                        )}
                    />
                )}

                {prefsFellBack && phase !== "searching" && phase !== "error" && (
                    <div className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 max-w-md">
                        {t(
                            "watch.prefs_fell_back",
                            "Aucune source ne correspondait à vos préférences (qualité / langue). La meilleure source disponible a été utilisée.",
                        )}
                    </div>
                )}

                {phase === "picking" && (
                    <ReleasePicker
                        releases={filteredReleases}
                        onPick={handleManualPick}
                    />
                )}

                {phase === "preparing" && pickedRelease && (
                    <PreparingPanel
                        release={pickedRelease}
                        label={
                            pickedRelease.cached
                                ? t(
                                    "watch.torbox_cached",
                                    "TorBox prépare le flux (instantané, source en cache)...",
                                )
                                : t(
                                    "watch.torbox_downloading",
                                    "TorBox télécharge la source — cela peut prendre 1-3 min...",
                                )
                        }
                        onChangeSource={handleChangeSource}
                    />
                )}

                {phase === "error" && (
                    <ErrorPanel
                        message={errorMsg ?? t("watch.unknown_error", "Une erreur est survenue.")}
                        onRetry={handleRetry}
                        onChangeSource={
                            (search.data?.length ?? 0) > 0 ? handleChangeSource : undefined
                        }
                    />
                )}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LoadingPanel({ label, sublabel }: { label: string; sublabel?: string }) {
    return (
        <div className="flex flex-col items-center gap-3 text-white">
            <FiLoader className="size-10 animate-spin text-brand-500" />
            <p className="text-base lg:text-lg font-semibold">{label}</p>
            {sublabel && (
                <p className="text-xs text-[--muted] max-w-md">{sublabel}</p>
            )}
        </div>
    )
}

function PreparingPanel({
    release,
    label,
    onChangeSource,
}: {
    release: Release
    label: string
    onChangeSource: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center gap-4 text-white max-w-2xl">
            <FiLoader className="size-10 animate-spin text-brand-500" />
            <p className="text-base lg:text-lg font-semibold">{label}</p>
            <div className="flex items-center gap-2 flex-wrap justify-center text-xs">
                <QualityBadge quality={release.quality} />
                {release.cached && <CachedBadge />}
                {hasFrenchAudio(release.title) && <LangBadge label="FR" />}
                <span className="text-[--muted]">{release.indexer}</span>
            </div>
            <p className="text-xs text-[--muted] line-clamp-2 max-w-md">
                {release.title}
            </p>
            <Button
                onClick={onChangeSource}
                size="sm"
                intent="white-subtle"
                leftIcon={<BiRefresh className="size-4" />}
                className="rounded-md mt-2"
            >
                {t("watch.change_source", "Changer de source")}
            </Button>
        </div>
    )
}

function ErrorPanel({
    message,
    onRetry,
    onChangeSource,
}: {
    message: string
    onRetry: () => void
    onChangeSource?: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center gap-4 text-white max-w-md">
            <p className="text-base lg:text-lg font-semibold text-red-300">{message}</p>
            <div className="flex items-center gap-2 flex-wrap justify-center">
                <Button
                    onClick={onRetry}
                    size="md"
                    intent="white-subtle"
                    className="rounded-md"
                >
                    {t("watch.retry", "Réessayer")}
                </Button>
                {onChangeSource && (
                    <Button
                        onClick={onChangeSource}
                        size="md"
                        intent="gray-subtle"
                        leftIcon={<BiRefresh className="size-4" />}
                        className="rounded-md"
                    >
                        {t("watch.change_source", "Changer de source")}
                    </Button>
                )}
            </div>
        </div>
    )
}

/**
 * Release picker — shows the top 12 results in a compact list. Backend
 * already sorted by (cached, score, seeders), so the first row is the
 * recommended choice (and what auto-picked, if the user is here it's
 * because they wanted to override).
 */
function ReleasePicker({
    releases,
    onPick,
}: {
    releases: Release[]
    onPick: (release: Release) => void
}) {
    const { t } = useTranslation()
    const top = releases.slice(0, 12)

    return (
        <div className="w-full max-w-3xl text-left">
            <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-white text-lg lg:text-xl font-bold">
                    {t("watch.pick_source", "Choisissez une source")}
                </h2>
                <span className="text-xs text-[--muted]">
                    {releases.length} {t("watch.results", "résultats")}
                </span>
            </div>
            <ul className="space-y-2">
                {top.map((release, i) => (
                    <li key={release.guid || release.infoHash || release.title}>
                        <button
                            type="button"
                            onClick={() => onPick(release)}
                            className={cn(
                                "w-full text-left group flex items-start gap-3 p-3 rounded-lg",
                                "bg-white/5 hover:bg-white/10 border border-white/10",
                                "hover:border-brand-500/60 transition-colors",
                                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
                                i === 0 && "ring-1 ring-brand-500/40",
                            )}
                        >
                            <div className="flex-1 min-w-0 space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap text-xs">
                                    {release.cached && <CachedBadge />}
                                    <QualityBadge quality={release.quality} />
                                    {hasFrenchAudio(release.title) && <LangBadge label="FR" />}
                                    <span className="text-[--muted]">{release.indexer}</span>
                                    {i === 0 && (
                                        <span className="text-brand-400 font-semibold">
                                            ★ {t("watch.recommended", "Recommandé")}
                                        </span>
                                    )}
                                </div>
                                <p className="text-sm text-white line-clamp-1 group-hover:text-brand-200">
                                    {release.title}
                                </p>
                                <div className="flex items-center gap-3 text-xs text-[--muted]">
                                    <span>↑ {release.seeders}</span>
                                    <span>{formatSize(release.size)}</span>
                                </div>
                            </div>
                            <BiPlay className="size-6 text-white/40 group-hover:text-white shrink-0 mt-1" />
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    )
}

function QualityBadge({ quality }: { quality: string }) {
    if (!quality || quality === "?") return null
    return (
        <span className="px-1.5 py-0.5 rounded bg-white/10 text-white font-semibold text-[10px] tracking-wide">
            {quality}
        </span>
    )
}

function CachedBadge() {
    const { t } = useTranslation()
    return (
        <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-500/20 text-green-300 font-semibold text-[10px]"
            title={t("watch.cached_tooltip", "Disponible immédiatement sur TorBox")}
        >
            <BiSolidCheckCircle className="size-3" />
            {t("watch.cached", "Cache")}
        </span>
    )
}

function LangBadge({ label }: { label: string }) {
    return (
        <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-semibold text-[10px]">
            {label}
        </span>
    )
}

// Re-exported helper from the shared preferences module so the badge logic
// in this file stays in sync with the modal's audio filter.
const hasFrenchAudio = releaseHasFrenchAudio

function formatSize(bytes: number): string {
    if (!bytes) return ""
    const gb = bytes / (1 << 30)
    if (gb >= 1) return `${gb.toFixed(1)} GB`
    const mb = bytes / (1 << 20)
    return `${mb.toFixed(0)} MB`
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

function Player({
    src,
    title,
    releaseTitle,
    onBack,
    onChangeSource,
}: {
    src: string
    title: string
    releaseTitle: string
    onBack: () => void
    onChangeSource: () => void
}) {
    const { t } = useTranslation()
    const videoRef = React.useRef<HTMLVideoElement>(null)

    // Picture-in-Picture on tab blur — Netflix-style "keep playing while I
    // check Slack". Restored when the user comes back.
    React.useEffect(() => {
        const video = videoRef.current
        if (!video) return
        const onVisibilityChange = () => {
            if (
                document.hidden &&
                !video.paused &&
                document.pictureInPictureElement !== video &&
                typeof video.requestPictureInPicture === "function"
            ) {
                video.requestPictureInPicture().catch(() => {})
            }
        }
        document.addEventListener("visibilitychange", onVisibilityChange)
        return () => document.removeEventListener("visibilitychange", onVisibilityChange)
    }, [])

    return (
        <div className="fixed inset-0 z-[100] bg-black flex flex-col">
            {/* Top bar — back button, title, change-source escape hatch. */}
            <div className="absolute top-0 inset-x-0 z-10 p-3 sm:p-4 flex items-center gap-2 sm:gap-3 bg-gradient-to-b from-black/80 to-transparent">
                <button
                    type="button"
                    onClick={onBack}
                    className="p-2 rounded-full text-white hover:bg-white/10"
                    aria-label={t("watch.back", "Retour")}
                >
                    <BiArrowBack className="size-6" />
                </button>
                <div className="min-w-0 flex-1">
                    <p className="text-white font-semibold truncate">{title}</p>
                    <p className="text-[--muted] text-xs truncate">{releaseTitle}</p>
                </div>
                <button
                    type="button"
                    onClick={onChangeSource}
                    className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-white text-sm bg-white/10 hover:bg-white/20"
                >
                    <BiRefresh className="size-4" />
                    {t("watch.change_source", "Changer de source")}
                </button>
            </div>

            <video
                ref={videoRef}
                src={src}
                autoPlay
                controls
                playsInline
                className="w-full h-full object-contain"
                onError={() => {
                    console.error("[Notflix] video error on", src)
                }}
            />
        </div>
    )
}
