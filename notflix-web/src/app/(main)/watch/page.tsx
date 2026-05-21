/**
 * Notflix watch page — TMDB → Prowlarr → TorBox → native <video>.
 *
 * Five UI states, walked in order:
 *
 *   splash      Banner + "Lancer la lecture" button. The click is the
 *               browser user-gesture that lets audio autoplay in the next phase.
 *   searching   Hitting /api/v1/prowlarr/search/{movie|tv}; spinner.
 *   picking     The release list, ranked by the backend (cached → score →
 *               seeders). User picks one (or the top auto-selects).
 *   preparing   POST /api/v1/torbox/play → magnet resolves to a stream URL.
 *               Can take up to 3 min on a non-cached torrent; shows a
 *               progress message so the user knows we didn't freeze.
 *   playing     Native <video> mounted on the resolved URL. PiP-on-blur
 *               kicks in so the player keeps going if the user tabs away.
 */
import { Release, useSearchMovie, useSearchTV, useTorBoxPlay } from "@/lib/notflix-api"
import { titleOf, tmdbImage, useTMDBDetail, yearOf } from "@/lib/tmdb"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { useSearchParams } from "@/lib/navigation"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiArrowBack, BiCheckCircle, BiPlay, BiSolidCheckCircle } from "react-icons/bi"
import { FiLoader } from "react-icons/fi"

type Phase = "splash" | "searching" | "picking" | "preparing" | "playing" | "error"

export default function WatchPage() {
    const { t } = useTranslation()
    const searchParams = useSearchParams()
    const idParam = searchParams.get("id")
    const typeParam = (searchParams.get("type") as "movie" | "tv" | null) ?? "movie"
    const seasonParam = searchParams.get("season")
    const episodeParam = searchParams.get("episode")

    const mediaId = idParam ? parseInt(idParam, 10) : NaN
    const season = seasonParam ? parseInt(seasonParam, 10) : undefined
    const episode = episodeParam ? parseInt(episodeParam, 10) : undefined

    const { data: detail, isLoading: detailLoading } = useTMDBDetail(
        typeParam,
        Number.isNaN(mediaId) ? null : mediaId,
    )

    const [phase, setPhase] = React.useState<Phase>("splash")
    const [pickedRelease, setPickedRelease] = React.useState<Release | null>(null)
    const [streamUrl, setStreamUrl] = React.useState<string | null>(null)
    const [errorMsg, setErrorMsg] = React.useState<string | null>(null)

    // Backend search — only fires when the user clicks "Lancer la lecture",
    // not on page load. Saves a Prowlarr roundtrip if the user bounces away.
    const title = detail ? titleOf(detail) : ""
    const year = detail ? Number(yearOf(detail)) : undefined
    const movieSearch = useSearchMovie(
        phase === "searching" || phase === "picking" ? title : "",
        year,
    )
    const tvSearch = useSearchTV(
        phase === "searching" || phase === "picking" ? title : "",
        season,
        episode,
    )
    const search = typeParam === "tv" ? tvSearch : movieSearch

    React.useEffect(() => {
        if (phase !== "searching") return
        if (search.isFetching) return
        if (search.data && search.data.length > 0) {
            setPhase("picking")
        } else if (search.data && search.data.length === 0) {
            setErrorMsg(t("watch.no_release", "Aucune source trouvée pour ce titre."))
            setPhase("error")
        } else if (search.isError) {
            setErrorMsg(t("watch.search_failed", "La recherche Prowlarr a échoué."))
            setPhase("error")
        }
    }, [phase, search.isFetching, search.data, search.isError])

    const play = useTorBoxPlay()

    const handleStart = React.useCallback(() => {
        if (!title) return
        setErrorMsg(null)
        setPhase("searching")
    }, [title])

    const handlePick = React.useCallback(
        async (release: Release) => {
            if (!release.magnetUrl && !release.infoHash) {
                setErrorMsg(t("watch.no_magnet", "Cette source n'expose pas de lien magnet."))
                setPhase("error")
                return
            }
            setPickedRelease(release)
            setPhase("preparing")
            try {
                const magnet =
                    release.magnetUrl ||
                    `magnet:?xt=urn:btih:${release.infoHash}&dn=${encodeURIComponent(release.title)}`
                const result = await play.mutateAsync({ magnet })
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

    const handleRetry = React.useCallback(() => {
        setErrorMsg(null)
        setPickedRelease(null)
        setStreamUrl(null)
        setPhase("splash")
    }, [])

    const handleBackToPicker = React.useCallback(() => {
        setStreamUrl(null)
        setPickedRelease(null)
        setPhase("picking")
    }, [])

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
                onBack={handleBackToPicker}
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

                {phase === "splash" && (
                    <SplashPanel
                        onStart={handleStart}
                        disabled={detailLoading || !title}
                    />
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

                {phase === "picking" && (
                    <ReleasePicker
                        releases={search.data ?? []}
                        onPick={handlePick}
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
                    />
                )}

                {phase === "error" && (
                    <ErrorPanel
                        message={errorMsg ?? t("watch.unknown_error", "Une erreur est survenue.")}
                        onRetry={handleRetry}
                    />
                )}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SplashPanel({ onStart, disabled }: { onStart: () => void; disabled?: boolean }) {
    const { t } = useTranslation()
    return (
        <>
            <Button
                onClick={onStart}
                disabled={disabled}
                size="xl"
                leftIcon={<BiPlay className="text-3xl" />}
                className="bg-white !text-black hover:!bg-white/90 font-bold px-10 rounded-md mt-4 disabled:opacity-50"
                autoFocus
            >
                {t("watch.start", "Lancer la lecture")}
            </Button>
            <p className="text-xs text-[--muted] max-w-md mt-2">
                {t(
                    "watch.click_hint",
                    "Notflix va rechercher la meilleure source disponible puis la lancer via TorBox.",
                )}
            </p>
        </>
    )
}

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

function PreparingPanel({ release, label }: { release: Release; label: string }) {
    return (
        <div className="flex flex-col items-center gap-4 text-white max-w-2xl">
            <FiLoader className="size-10 animate-spin text-brand-500" />
            <p className="text-base lg:text-lg font-semibold">{label}</p>
            <div className="flex items-center gap-2 flex-wrap justify-center text-xs">
                <QualityBadge quality={release.quality} />
                {release.cached && <CachedBadge />}
                <span className="text-[--muted]">{release.indexer}</span>
            </div>
            <p className="text-xs text-[--muted] line-clamp-2 max-w-md">
                {release.title}
            </p>
        </div>
    )
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center gap-4 text-white max-w-md">
            <p className="text-base lg:text-lg font-semibold text-red-300">{message}</p>
            <Button
                onClick={onRetry}
                size="md"
                intent="white-subtle"
                className="rounded-md"
            >
                {t("watch.retry", "Réessayer")}
            </Button>
        </div>
    )
}

/**
 * Release picker — shows the top 8 results in a compact list. Backend already
 * sorted by (cached, score, seeders), so the first row is the recommended
 * choice. The user can scroll to see lower-quality fallbacks.
 */
function ReleasePicker({
    releases,
    onPick,
}: {
    releases: Release[]
    onPick: (release: Release) => void
}) {
    const { t } = useTranslation()
    // Limit to top 12 — beyond that the list is just noise for a casual viewer.
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

function hasFrenchAudio(title: string): boolean {
    const t = title.toLowerCase()
    return t.includes("french") || t.includes("multi") || t.includes("vff") || t.includes("truefrench")
}

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
}: {
    src: string
    title: string
    releaseTitle: string
    onBack: () => void
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
            {/* Top bar — title + back button. Auto-fade could come later. */}
            <div className="absolute top-0 inset-x-0 z-10 p-4 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent">
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
            </div>

            <video
                ref={videoRef}
                src={src}
                autoPlay
                controls
                playsInline
                className="w-full h-full object-contain"
                onError={() => {
                    // Surface the error so the parent can re-show the picker.
                    // (Kept minimal — a fancier flow would pop a toast.)
                    console.error("[Notflix] video error on", src)
                }}
            />
        </div>
    )
}
