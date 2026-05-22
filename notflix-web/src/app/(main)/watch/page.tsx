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
import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { NetflixWatchHistorySaver } from "@/app/(main)/_features/netflix/netflix-watch-history-saver"
import {
    getSubPrepStatus,
    Release,
    releaseTorBoxPayload,
    startSubPrep,
    SubPrepStatus,
    SubtitleTrack,
    useSearchMovie,
    useSearchTV,
    useTorBoxPlay,
} from "@/lib/notflix-api"
import Hls from "hls.js"
import {
    AudioPref,
    QualityPref,
    SubtitleLangPref,
    releaseHasFrenchAudio,
    releaseHasIncompatibleAudio,
    releaseMatchesAudio,
    releaseMatchesQuality,
    releaseNeedsTransmux,
    useSourcePickMode,
    useSubPrepMode,
    useSubtitleLangPref,
} from "@/lib/preferences"
import { titleOf, tmdbImage, useTMDBDetail, useTMDBSeason, yearOf } from "@/lib/tmdb"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { useRouter, useSearchParams } from "@/lib/navigation"
import { toast } from "sonner"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiArrowBack, BiPlay, BiRefresh, BiSolidCheckCircle } from "react-icons/bi"
import { FiLoader } from "react-icons/fi"

type Phase = "searching" | "picking" | "preparing" | "preparing_subs" | "playing" | "error"

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

    // Optional resume position: /watch?id=…&t=4567 seeks the <video>
    // to that many seconds on first canplay. Used by the home's
    // "Reprendre la lecture" rail and could be exposed elsewhere later.
    const resumeSecParam = searchParams.get("t")
    const resumeSec = resumeSecParam ? parseInt(resumeSecParam, 10) : 0

    // Optional pre-selected release. When the resume rail / history grid
    // links here, they encode the original release's source so we can
    // skip the Prowlarr search + auto-pick and re-stream the exact same
    // file. Without these, switching from a 1080p AAC to a 2160p DDP
    // would scramble the resume timestamp (different duration).
    const resumeReleaseSource = searchParams.get("releaseSource") ?? ""
    const resumeReleaseName = searchParams.get("releaseName") ?? ""
    const resumeReleaseHash = searchParams.get("releaseHash") ?? ""

    // Playback prefs come from the modal's selectors via the URL.
    const qualityPref = (searchParams.get("quality") as QualityPref | null) ?? "auto"
    const audioPref = (searchParams.get("audio") as AudioPref | null) ?? "auto"
    // Subtitles default to the persisted localStorage preference when no
    // explicit URL param was set. Lets the player honour the user's
    // pick even when arriving via "Reprendre la lecture" (which only
    // forwards the resume position).
    const [storedSubLang] = useSubtitleLangPref()
    const subLangPref = (searchParams.get("sub") as SubtitleLangPref | null) ?? storedSubLang

    const { data: detail, isLoading: detailLoading } = useTMDBDetail(
        typeParam,
        Number.isNaN(mediaId) ? null : mediaId,
    )

    // "auto" = fire the top release as soon as the search resolves.
    // "manual" = stop at the picker so the user always chooses.
    const [sourcePickMode] = useSourcePickMode()
    // "wait" = block playback on subtitle prep (progress overlay).
    // "background" = play immediately, mount tracks when ready.
    const [subPrepMode] = useSubPrepMode()

    const [phase, setPhase] = React.useState<Phase>("searching")
    const [pickedRelease, setPickedRelease] = React.useState<Release | null>(null)
    const [streamUrl, setStreamUrl] = React.useState<string | null>(null)
    const [streamAudioCodec, setStreamAudioCodec] = React.useState<string>("")
    const [streamVideoCodec, setStreamVideoCodec] = React.useState<string>("")
    const [streamContainer, setStreamContainer] = React.useState<string>("")
    const [streamDurationSec, setStreamDurationSec] = React.useState<number>(0)
    const [streamSubtitles, setStreamSubtitles] = React.useState<SubtitleTrack[]>([])
    const [streamSessionId, setStreamSessionId] = React.useState<string>("")
    const [subPrep, setSubPrep] = React.useState<SubPrepStatus | null>(null)
    const [errorMsg, setErrorMsg] = React.useState<string | null>(null)
    // Lets the user opt out of the auto-pick: once they click "Changer de
    // source" we stop trying to launch the top result behind their back.
    // Initialised from sourcePickMode so the settings preference takes
    // effect on the very first /watch open without an extra click.
    const [autoPickDisabled, setAutoPickDisabled] = React.useState(
        sourcePickMode === "manual",
    )

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
        setStreamAudioCodec("")
        setStreamVideoCodec("")
        setStreamContainer("")
        setStreamDurationSec(0)
        setStreamSubtitles([])
        setStreamSessionId("")
        setSubPrep(null)
        setErrorMsg(null)
        // Honour the settings preference on the reset too — manual mode
        // means "always stop at the picker", not "stop the first time".
        setAutoPickDisabled(sourcePickMode === "manual")
        setSkipKeys(new Set())
        setFallbackAttempt(0)
    }, [mediaId, typeParam, season, episode, sourcePickMode])

    // Prowlarr searches as soon as we know the title. No splash step — the
    // user's click on "Lecture" upstream IS the user gesture; we just keep
    // moving.
    const title = detail ? titleOf(detail) : ""
    const year = detail ? Number(yearOf(detail)) : undefined
    const movieSearch = useSearchMovie(typeParam === "movie" ? title : "", year)
    const tvSearch = useSearchTV(typeParam === "tv" ? title : "", season, episode)
    const search = typeParam === "tv" ? tvSearch : movieSearch

    const play = useTorBoxPlay()

    // Apply the user's quality / audio prefs as a post-search filter, then
    // drop browser-incompatible audio codecs (Chrome can't decode DDP /
    // DTS / TrueHD / Atmos; Safari can but it's a minority). If a filter
    // step wipes the list, we relax it gracefully so the user can still
    // play *something*.
    const filteredReleases = React.useMemo(() => {
        const all = search.data ?? []
        if (all.length === 0) return all

        // Step 1: user prefs (quality + lang)
        const prefMatched =
            qualityPref === "auto" && audioPref === "auto"
                ? all
                : all.filter(
                    r =>
                        releaseMatchesQuality(r.quality, qualityPref) &&
                        releaseMatchesAudio(r.title, audioPref),
                )
        const base = prefMatched.length > 0 ? prefMatched : all

        // Step 2: browser-decodable audio. Keep DDP/DTS/etc. as a last-
        // resort if every release would be filtered out — better a muted
        // playback than nothing at all.
        const browserOk = base.filter(r => !releaseHasIncompatibleAudio(r.title))
        return browserOk.length > 0 ? browserOk : base
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

    // releaseKey — stable identifier across renders for skip-tracking.
    const releaseKey = React.useCallback(
        (r: Release) => r.guid || r.infoHash || r.title,
        [],
    )

    // Hoisted up here because handleFatalPlaybackError (which lives a
    // few hundred lines down) references it. Cheap hook, no work done
    // beyond returning the jotai setter pair.
    const { openDetail } = useNetflixDetailModal()

    // Track which releases we've already tried in this session so the
    // auto-fallback doesn't loop on the same one.
    const [skipKeys, setSkipKeys] = React.useState<Set<string>>(new Set())
    const [fallbackAttempt, setFallbackAttempt] = React.useState(0)

    // The actual launch — tries the given release; on TorBox failure
    // (BOZO_TORRENT, timeout, unusable payload, …) silently moves on to
    // the next ranked release. Up to 3 tries total before surfacing the
    // last error in the panel.
    //
    // `skip` threads through as a local Set so the closure doesn't race
    // with React state across the recursive calls.
    const MAX_TRIES = 3
    const launchRelease = React.useCallback(
        async (release: Release, skip: Set<string> = new Set()): Promise<void> => {
            const key = releaseKey(release)
            skip.add(key)
            setSkipKeys(new Set(skip))

            const tryNext = async (lastError?: Error) => {
                if (skip.size >= MAX_TRIES) {
                    setErrorMsg(
                        lastError?.message ??
                            t("watch.torbox_failed", "TorBox n'a pas pu préparer le flux."),
                    )
                    setPhase("error")
                    return
                }
                const next = filteredReleases.find(r => !skip.has(releaseKey(r)))
                if (!next) {
                    setErrorMsg(
                        lastError?.message ??
                            t("watch.no_release", "Plus aucune source à essayer."),
                    )
                    setPhase("error")
                    return
                }
                setFallbackAttempt(skip.size)
                await launchRelease(next, skip)
            }

            const payload = releaseTorBoxPayload(release)
            if (!payload) {
                console.warn("[Notflix] unusable release skipped:", release.title)
                await tryNext()
                return
            }

            setPickedRelease(release)
            setStreamUrl(null)
            setStreamAudioCodec("")
            setStreamVideoCodec("")
            setStreamContainer("")
            setStreamDurationSec(0)
            setErrorMsg(null)
            setPhase("preparing")
            try {
                const result = await play.mutateAsync(payload)
                setStreamUrl(result.streamUrl)
                setStreamAudioCodec(result.audioCodec ?? "")
                setStreamVideoCodec(result.videoCodec ?? "")
                setStreamContainer(result.container ?? "")
                setStreamDurationSec(
                    typeof (result as { durationSec?: number }).durationSec === "number"
                        ? (result as { durationSec: number }).durationSec
                        : 0,
                )
                setStreamSubtitles(result.subtitles ?? [])
                setStreamSessionId(result.sessionId ?? "")
                // Decide whether to BLOCK on subtitle prep:
                //   - off / no subs / no session   → skip prep, play
                //   - subPrepMode = "background"   → kick prep off in
                //     the background, play immediately. <track>
                //     elements still mount; they populate once the
                //     backend cache file is ready.
                //   - default ("wait")             → show progress
                //     overlay until ready.
                const noSubsToShow =
                    subLangPref === "off" ||
                    !result.sessionId ||
                    (result.subtitles ?? []).length === 0
                if (noSubsToShow) {
                    setPhase("playing")
                } else if (subPrepMode === "background") {
                    // Fire-and-forget — backend extracts on its own
                    // pace; we don't wait for the result.
                    if (result.sessionId) {
                        void startSubPrep(result.sessionId, subLangPref).catch(err => {
                            console.warn("[Notflix] background sub prep failed to start:", err)
                        })
                    }
                    setPhase("playing")
                } else {
                    setPhase("preparing_subs")
                }
                setFallbackAttempt(0)
            } catch (err) {
                console.warn("[Notflix] release failed, trying next:", release.title, err)
                await tryNext(err instanceof Error ? err : undefined)
            }
        },
        [play, filteredReleases, releaseKey, t],
    )

    // Synthesised release used when /watch is loaded with an explicit
    // resume release (e.g. from the home's "Reprendre la lecture" card).
    // We build a Release-shaped object so the existing launchRelease
    // pipeline can drive it without caring whether it came from a
    // Prowlarr search or a stored history row.
    const resumeRelease = React.useMemo<Release | null>(() => {
        if (!resumeReleaseSource && !resumeReleaseHash) return null
        const isMagnet = resumeReleaseSource.toLowerCase().startsWith("magnet:")
        return {
            guid: `resume:${resumeReleaseHash || resumeReleaseSource}`,
            title: resumeReleaseName || "Source précédente",
            indexer: "history",
            protocol: "torrent",
            size: 0,
            seeders: 0,
            leechers: 0,
            publishDate: "",
            magnetUrl: isMagnet ? resumeReleaseSource : "",
            downloadUrl: isMagnet ? "" : resumeReleaseSource,
            infoHash: resumeReleaseHash,
            cached: false,
            quality: "?",
            score: 0,
        }
    }, [resumeReleaseSource, resumeReleaseName, resumeReleaseHash])

    // Auto-pick: fire the top (pref-filtered) release as soon as the search
    // resolves, unless the user has explicitly opted into manual picking.
    //
    // When a resumeRelease is present we short-circuit the search step
    // entirely — different code path, no Prowlarr roundtrip, no chance
    // of picking a different file.
    React.useEffect(() => {
        if (phase !== "searching") return
        if (resumeRelease) {
            void launchRelease(resumeRelease)
            return
        }
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
    }, [phase, resumeRelease, search.isFetching, search.isError, filteredReleases, autoPickDisabled, launchRelease, t])

    // Background sub-prep poller — runs throughout the "playing" phase
    // when subPrepMode is "background", so we can show a small corner
    // indicator and auto-activate the track once the backend cache
    // is ready. Independent from the blocking polling loop below.
    React.useEffect(() => {
        if (phase !== "playing") return
        if (!streamSessionId) return
        if (subLangPref === "off") return
        if (subPrepMode !== "background") return
        // Already known to be ready → nothing to poll for.
        if (subPrep?.state === "ready") return

        let cancelled = false
        const tick = async () => {
            try {
                const status = await getSubPrepStatus(streamSessionId)
                if (cancelled) return
                setSubPrep(status)
                if (status.state === "ready" || status.state === "failed") {
                    return // stop polling
                }
            } catch (err) {
                console.warn("[Notflix] background prep poll failed:", err)
                return
            }
            if (!cancelled) window.setTimeout(tick, 1500)
        }
        void tick()
        return () => {
            cancelled = true
        }
    }, [phase, streamSessionId, subLangPref, subPrepMode, subPrep?.state])

    // Subtitle prep loop — fires when phase enters "preparing_subs".
    // Kicks off the backend's extract+translate pipeline, polls the
    // status endpoint every 500 ms, and transitions to "playing" once
    // the backend reports `ready` (success) or `failed` after we've
    // shown the error message long enough for the user to read it.
    React.useEffect(() => {
        if (phase !== "preparing_subs") return
        if (!streamSessionId) return
        let cancelled = false

        // Lets us pause before transitioning on "failed" so the user
        // sees what went wrong instead of the overlay flicking past.
        const advanceToPlaying = (delayMs: number) => {
            window.setTimeout(() => {
                if (!cancelled) setPhase("playing")
            }, delayMs)
        }

        const tick = async () => {
            try {
                const status = await getSubPrepStatus(streamSessionId)
                if (cancelled) return
                setSubPrep(status)
                if (status.state === "ready") {
                    setPhase("playing")
                    return
                }
                if (status.state === "failed") {
                    // Hold for 3 s so the user sees the failure reason
                    // before the video takes over.
                    advanceToPlaying(3000)
                    return
                }
            } catch (err) {
                console.warn("[Notflix] sub prep status fetch failed:", err)
                if (!cancelled) setPhase("playing")
                return
            }
            if (!cancelled) {
                window.setTimeout(tick, 500)
            }
        }

        ;(async () => {
            try {
                const initial = await startSubPrep(streamSessionId, subLangPref)
                if (cancelled) return
                setSubPrep(initial)
                if (initial.state === "ready") {
                    setPhase("playing")
                    return
                }
                if (initial.state === "failed") {
                    advanceToPlaying(3000)
                    return
                }
            } catch (err) {
                console.warn("[Notflix] sub prep start failed:", err)
                if (!cancelled) setPhase("playing")
                return
            }
            void tick()
        })()

        return () => {
            cancelled = true
        }
    }, [phase, streamSessionId, subLangPref])

    const handleChangeSource = React.useCallback(() => {
        setAutoPickDisabled(true)
        setStreamUrl(null)
        setErrorMsg(null)
        setPhase("picking")
    }, [])

    // Fatal playback error → mark the current release as broken and
    // auto-try the next ranked one. Triggered by <video onError> when
    // the browser can't decode the source (typical case: XviD AVI release
    // that ffprobe-failed and direct-played anyway).
    //
    // Throttled with a ref so a video that errors mid-playback doesn't
    // loop the fallback forever. One fall-through per (release, mount).
    const fatalErrorHandledForRef = React.useRef<string>("")
    const handleFatalPlaybackError = React.useCallback(() => {
        if (!pickedRelease) return
        const key = releaseKey(pickedRelease)
        if (fatalErrorHandledForRef.current === key) return
        fatalErrorHandledForRef.current = key

        console.warn(
            "[Notflix] playback failed for release, auto-trying next:",
            pickedRelease.title,
        )

        const newSkip = new Set(skipKeys)
        newSkip.add(key)
        setSkipKeys(newSkip)

        // When we run out of fallbacks (or the picker would be empty),
        // navigate back to the detail modal — that's where the user
        // came from, and where they can pick a different release by
        // hand. A sonner toast carries the reason so they don't have
        // to dig into devtools.
        const bailToModal = (msg: string) => {
            toast.error(msg)
            if (!Number.isNaN(mediaId)) {
                openDetail(mediaId, typeParam, typeParam === "tv" ? season : undefined)
            }
            if (window.history.length > 1) {
                router.back()
            } else {
                router.push("/")
            }
        }

        if (newSkip.size >= 3) {
            bailToModal(t("watch.no_compatible_source", "Aucune source compatible avec ton navigateur. Essaie une autre release."))
            return
        }

        const next = filteredReleases.find(r => !newSkip.has(releaseKey(r)))
        if (!next) {
            bailToModal(t("watch.no_release", "Plus aucune source à essayer. Choisis une autre release."))
            return
        }

        // Still have a candidate — surface a quieter toast so the user
        // knows we're switching, then launch it.
        toast(t("watch.fallback_trying_next", "Source incompatible, essai d'une autre…"), {
            duration: 2500,
        })
        void launchRelease(next, newSkip)
    }, [pickedRelease, releaseKey, skipKeys, filteredReleases, launchRelease, t, mediaId, typeParam, season, openDetail, router])

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
        setStreamAudioCodec("")
        setStreamVideoCodec("")
        setStreamContainer("")
        setStreamDurationSec(0)
        setStreamSubtitles([])
        setStreamSessionId("")
        setSubPrep(null)
        // Re-apply the preference: in manual mode "Réessayer" still lands
        // back on the picker, not on an auto-launch.
        setAutoPickDisabled(sourcePickMode === "manual")
        setSkipKeys(new Set())
        setFallbackAttempt(0)
        setPhase("searching")
    }, [sourcePickMode])

    const handleClose = React.useCallback(() => {
        // Re-open the detail modal for the media we were watching, so the
        // user can pick a different episode / source without going through
        // search again. For TV, restore the same season they were on so
        // they don't have to navigate back to S2 / S3 / … from scratch.
        //
        // The actual URL navigation still does router.back() — the modal
        // opens on top of whatever page that brings us back to (home,
        // /lists, /search, /categories, …), so the user keeps their
        // browsing context.
        if (!Number.isNaN(mediaId)) {
            openDetail(mediaId, typeParam, typeParam === "tv" ? season : undefined)
        }
        if (window.history.length > 1) {
            router.back()
        } else {
            router.push("/")
        }
    }, [router, openDetail, mediaId, typeParam, season])

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
            <>
                {/* Per-profile history mirror — fires every 5s + on
                    pagehide. No-op without an active profile. Carries
                    the release identifiers so resume can re-pick the
                    same source. */}
                <NetflixWatchHistorySaver
                    tmdbId={mediaId}
                    mediaType={typeParam}
                    season={season}
                    episode={episode}
                    title={displayTitle}
                    posterPath={detail?.poster_path ?? ""}
                    backdropUrl={detail?.backdrop_path ?? ""}
                    release={pickedRelease}
                />
                <Player
                    src={streamUrl}
                    title={displayTitle}
                    releaseTitle={pickedRelease?.title ?? ""}
                    audioCodec={streamAudioCodec}
                    videoCodec={streamVideoCodec}
                    container={streamContainer}
                    durationSec={streamDurationSec}
                    subtitles={streamSubtitles}
                    sessionId={streamSessionId}
                    subLangPref={subLangPref}
                    subPrep={subPrep}
                    resumeSec={resumeSec}
                    onBack={handleClose}
                    onChangeSource={handleChangeSource}
                    onFatalError={handleFatalPlaybackError}
                    nextEpisodeMediaId={typeParam === "tv" ? mediaId : null}
                    nextEpisodeSeason={typeParam === "tv" ? season : undefined}
                    nextEpisodeNumber={typeParam === "tv" ? episode : undefined}
                />
            </>
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
                                    "Source non en cache — TorBox la récupère (max 90s avant d'essayer une autre release)...",
                                )
                        }
                        fallbackAttempt={fallbackAttempt}
                        onChangeSource={handleChangeSource}
                    />
                )}

                {phase === "preparing_subs" && (
                    <SubPrepPanel
                        status={subPrep}
                        onSkip={() => setPhase("playing")}
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
    fallbackAttempt,
    onChangeSource,
}: {
    release: Release
    label: string
    fallbackAttempt: number
    onChangeSource: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center gap-4 text-white max-w-2xl">
            <FiLoader className="size-10 animate-spin text-brand-500" />
            {fallbackAttempt > 0 && (
                <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-1.5">
                    {t(
                        "watch.fallback_attempt",
                        "Source précédente indisponible — essai d'une autre…",
                    )}
                </p>
            )}
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

/** Progress overlay shown while ffmpeg extracts + Claude translates the
 *  user's preferred subtitle, before the video starts. Mirrors the
 *  PreparingPanel layout but with a determinate progress bar driven by
 *  the polled SubPrepStatus. */
function SubPrepPanel({
    status,
    onSkip,
}: {
    status: SubPrepStatus | null
    onSkip: () => void
}) {
    const { t } = useTranslation()
    // Friendly label for the source language being extracted (e.g.
    // "français", "anglais") — pulled from status.chosenLang which is
    // an ISO-639 tag like "fre" / "eng".
    const chosenLangName = React.useMemo(() => {
        if (!status?.chosenLang) return ""
        const code = normaliseSubLang(status.chosenLang)
        return subLangNames[code] || status.chosenLang
    }, [status?.chosenLang])

    const label = React.useMemo(() => {
        if (!status) return t("watch.sub_prep_starting", "Préparation des sous-titres...")
        switch (status.state) {
            case "picking":
                return t("watch.sub_prep_picking", "Choix de la meilleure source de sous-titres...")
            case "extracting":
                // Make the user-selected language explicit so it's
                // visible we're only extracting ONE track, not all of
                // them. Falls back to the generic label when chosenLang
                // hasn't been set yet (race during the initial poll).
                if (chosenLangName) {
                    return t(
                        "watch.sub_prep_extracting_lang",
                        "Extraction de la piste {{lang}} depuis la vidéo…",
                        { lang: chosenLangName },
                    )
                }
                return t("watch.sub_prep_extracting", "Extraction des sous-titres depuis la vidéo...")
            case "translating":
                return t(
                    "watch.sub_prep_translating",
                    "Traduction des sous-titres via Claude...",
                )
            case "ready":
                return t("watch.sub_prep_ready", "Sous-titres prêts, lancement…")
            case "failed":
                return t(
                    "watch.sub_prep_failed",
                    "Préparation échouée — lecture sans sous-titres.",
                )
            default:
                return t("watch.sub_prep_starting", "Préparation des sous-titres...")
        }
    }, [status, t, chosenLangName])

    const rawProgress = status?.progress ?? 0
    const progress = Math.max(0, Math.min(100, rawProgress))
    // Floor at 1% so the bar visibly nudges off zero as soon as we
    // enter extracting, without lying about the actual numeric
    // readout shown next to it.
    const displayBar = Math.max(progress, progress > 0 ? 1 : 0)

    return (
        <div className="flex flex-col items-center gap-5 text-white max-w-2xl w-full">
            <FiLoader className="size-10 animate-spin text-brand-500" />
            <p className="text-base lg:text-lg font-semibold text-center">{label}</p>

            {/* Determinate progress bar + numeric readout to 2 decimals.
                The text update is what tells the user "yes, something
                is happening" when the bar is still very low. */}
            <div className="w-full max-w-md space-y-2">
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-brand-500 transition-[width] duration-500 ease-out"
                        style={{ width: `${displayBar}%` }}
                    />
                </div>
                <p className="text-center text-xs tabular-nums text-white/80 font-mono">
                    {progress.toFixed(2)} %
                </p>
            </div>

            {status?.willTranslate && status.state !== "failed" && (
                <p className="text-xs text-[--muted] text-center max-w-md leading-relaxed">
                    {t(
                        "watch.sub_prep_translate_note",
                        "Aucun sous-titre dans la langue choisie — Claude traduit depuis {{lang}}. La traduction est mise en cache, donc le prochain lancement sera instantané.",
                        { lang: status.chosenLang || "?" },
                    )}
                </p>
            )}

            {status?.state === "failed" && status.error && (
                <p className="text-xs text-red-300 text-center max-w-2xl leading-relaxed bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2 font-mono break-all">
                    {status.error}
                </p>
            )}

            <button
                type="button"
                onClick={onSkip}
                className="text-xs text-[--muted] hover:text-white underline underline-offset-2"
            >
                {t("watch.sub_prep_skip", "Lancer sans attendre")}
            </button>
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
 * Release picker — shows every release the backend returned, in the
 * order it ranked them (cached × score × seeders). The first row is
 * the recommended choice and what auto-pick would have launched. We
 * used to cap at 12 but the user can have 30-50 anime sources in one
 * shot and capping was hiding the alternatives they wanted to choose
 * between, so the full list is now shown.
 */
function ReleasePicker({
    releases,
    onPick,
}: {
    releases: Release[]
    onPick: (release: Release) => void
}) {
    const { t } = useTranslation()

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
                {releases.map((release, i) => (
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
    audioCodec,
    videoCodec,
    container,
    durationSec,
    subtitles,
    sessionId,
    subLangPref,
    subPrep,
    resumeSec,
    onBack,
    onChangeSource,
    onFatalError,
    nextEpisodeMediaId,
    nextEpisodeSeason,
    nextEpisodeNumber,
}: {
    src: string
    title: string
    releaseTitle: string
    audioCodec: string
    videoCodec: string
    container: string
    durationSec: number
    subtitles: SubtitleTrack[]
    sessionId: string
    subLangPref: SubtitleLangPref
    subPrep: SubPrepStatus | null
    resumeSec: number
    onBack: () => void
    onChangeSource: () => void
    onFatalError: () => void
    nextEpisodeMediaId: number | null
    nextEpisodeSeason: number | undefined
    nextEpisodeNumber: number | undefined
}) {
    const { t } = useTranslation()
    const videoRef = React.useRef<HTMLVideoElement>(null)

    // Resume position from the URL. We consume it once on the first
    // loadedmetadata event so the player jumps there. Stored in a ref
    // so we don't refire on every render.
    const resumeRef = React.useRef(resumeSec)
    React.useEffect(() => {
        resumeRef.current = resumeSec
    }, [resumeSec])
    React.useEffect(() => {
        const video = videoRef.current
        if (!video) return
        const onLoaded = () => {
            const target = resumeRef.current
            if (target && target > 0 && Number.isFinite(video.duration) && target < video.duration) {
                video.currentTime = target
                resumeRef.current = 0 // consume once
            }
        }
        video.addEventListener("loadedmetadata", onLoaded)
        return () => video.removeEventListener("loadedmetadata", onLoaded)
    }, [src])

    // Decide the streaming path. The DIRECT path is always faster and
    // higher-quality (native browser playback, no ffmpeg, no re-encode),
    // so we use it whenever the browser advertises it can play the
    // source verbatim. Otherwise we fall back to HLS transmux.
    //
    // Feature-detection via HTMLMediaElement.canPlayType:
    //   "" / undefined  → no, force HLS
    //   "maybe"         → maybe, but unreliable — be safe, force HLS
    //   "probably"      → yes, use DIRECT
    //
    // We hand canPlayType a synthesised MIME type that combines the
    // container hint with codec strings. Examples:
    //   container=mov,mp4,...  + v=h264 + a=aac → "video/mp4; codecs=\"avc1.640028,mp4a.40.2\""
    //   container=matroska,... + v=h264 + a=aac → "video/x-matroska; codecs=\"avc1.640028,mp4a.40.2\""
    //   container=avi          + ...            → "video/x-msvideo" (browsers always say "")
    //
    // Falls back to "force HLS" on probe failure (empty codec / container)
    // — safer than trying DIRECT on an unknown format.
    const needsTransmux = React.useMemo(() => {
        return !canBrowserPlayDirect(container, videoCodec, audioCodec)
    }, [container, videoCodec, audioCodec])

    React.useEffect(() => {
        console.info(
            `[Notflix] probe: container=${container || "?"} v=${videoCodec || "?"} a=${audioCodec || "?"} → ` +
            `${needsTransmux ? "HLS transmux (seek OK)" : "DIRECT (seek OK)"}`,
        )
    }, [container, videoCodec, audioCodec, needsTransmux])

    // Debug: log what subtitle tracks we're trying to render. Lets the
    // user (and us) tell whether the issue is "backend returned 0 subs",
    // "backend returned subs but with empty language tags" or "tracks
    // mounted but the browser refused to load them".
    React.useEffect(() => {
        if (!sessionId) {
            console.info(`[Notflix] subtitles: no HLS session yet (skipping <track> render)`)
            return
        }
        if (subtitles.length === 0) {
            console.info(`[Notflix] subtitles: probe returned 0 tracks`)
            return
        }
        console.info(
            `[Notflix] subtitles: ${subtitles.length} tracks from probe`,
            subtitles.map(s => `${s.codec}/${s.language || "??"}${s.supported ? "" : " (UNSUPPORTED)"}`),
        )
        const resolved = resolveSubtitleTracks(subtitles, subLangPref)
        console.info(
            `[Notflix] subtitles: ${resolved.length} <track> rendered (pref=${subLangPref})`,
            resolved.map(t => `${t.srcLang}${t.translateTo ? " (translated)" : ""}${t.isDefault ? " *default*" : ""}`),
        )
    }, [sessionId, subtitles, subLangPref])

    // Drive the <video> source imperatively so we can:
    //   - flip between native src and hls.js attachMedia
    //   - tear down hls.js cleanly on unmount or source switch
    React.useEffect(() => {
        const video = videoRef.current
        if (!video) return
        let cancelled = false
        let hls: Hls | null = null

        if (!needsTransmux) {
            video.src = src
            return () => {
                video.removeAttribute("src")
                video.load()
            }
        }

        // Kick off an HLS session on the backend, then wire hls.js to
        // the playlist URL it returns. We forward the codec + duration
        // we already learnt from /torbox/play so the backend can skip
        // a second ffprobe (~1-2s saved). Safari natively plays HLS,
        // so we skip hls.js there.
        ;(async () => {
            try {
                const r = await fetch("/api/v1/stream/hls/start", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        url: src,
                        durationSec,
                        audioCodec,
                    }),
                })
                if (!r.ok) {
                    console.error("[Notflix] HLS start failed:", r.status, await r.text())
                    return
                }
                const j = (await r.json()) as { data: { playlistUrl: string } }
                if (cancelled) return
                const playlistUrl = j.data.playlistUrl

                if (Hls.isSupported()) {
                    hls = new Hls({
                        // Buffer 120 s of media ahead of the playhead.
                        // Lets the player ride out 30-60 s connection
                        // dips without rebuffering — the classic
                        // Netflix-like resilience to cellular handoffs.
                        maxBufferLength: 120,
                        maxMaxBufferLength: 240,
                        // Keep 60 s behind the playhead too so seek-back
                        // in the last minute doesn't trigger a refetch.
                        backBufferLength: 60,

                        // Initial bandwidth estimate: 50 Mbps. Bias the
                        // first chunk to the SOURCE variant — it's the
                        // one we prebake (`-c copy`, instant) so the
                        // player starts immediately. ABR will downshift
                        // to 720p on the second/third chunk if the
                        // measured bandwidth turns out to be lower.
                        // Starting on 720p was waiting 5-10 s for the
                        // first libx264 encode to finish; not worth it
                        // when source is ready.
                        abrEwmaDefaultEstimate: 50_000_000,
                        // Pick the highest level (source variant) at
                        // startup. ABR takes over from chunk 1 onwards.
                        startLevel: -1,
                        // Prefetch the next fragment while the current
                        // one is still playing → smoother handover.
                        startFragPrefetch: true,
                        // Allow level-down on a single failed fragment.
                        // Better UX than retrying the same level twice.
                        abrBandWidthFactor: 0.95,
                        abrBandWidthUpFactor: 0.7,

                        // Long timeouts because our backend transcodes
                        // chunks on demand (5-15 s cold start on remote
                        // sources; <1 s after the local cache is warm).
                        fragLoadingTimeOut: 60_000,
                        manifestLoadingTimeOut: 30_000,
                        levelLoadingTimeOut: 30_000,
                        fragLoadingMaxRetry: 6,
                        fragLoadingMaxRetryTimeout: 60_000,
                    })
                    hls.loadSource(playlistUrl)
                    hls.attachMedia(video)
                    hls.on(Hls.Events.ERROR, (_, data) => {
                        if (!data.fatal) return
                        console.error("[Notflix] hls fatal error", data)
                        // Trip the same fallback machinery the <video>
                        // onError uses. The most common causes here:
                        //   - HEVC in MPEG-TS (hls.js can't demux)
                        //   - fragLoadTimeOut on cold-start
                        //   - internalException after a parse error
                        // Skipping to the next ranked release is
                        // almost always the right move — the current
                        // one is unrecoverable.
                        onFatalError()
                    })
                } else {
                    // Safari + iOS Chrome have native HLS.
                    video.src = playlistUrl
                }
            } catch (err) {
                console.error("[Notflix] HLS init failed:", err)
            }
        })()

        return () => {
            cancelled = true
            if (hls) {
                hls.destroy()
                hls = null
            }
            video.removeAttribute("src")
            video.load()
        }
    }, [src, needsTransmux])

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

    // Auto-activate the preferred subtitle track once the backend
    // reports the cache is ready. Chrome eagerly fetches `default`
    // tracks at mount time; if the cache wasn't warm yet, that
    // initial fetch can fail silently and the track stays disabled
    // for the rest of playback. Solution: don't mark anything default,
    // and manually flip mode = "showing" once subPrep.state === ready.
    const [autoShownTrack, setAutoShownTrack] = React.useState(false)
    React.useEffect(() => {
        if (autoShownTrack) return
        if (subPrep?.state !== "ready") return
        const video = videoRef.current
        if (!video) return
        const target = subLangPref === "off" ? null : normaliseSubLang(subLangPref === "auto" ? "fr" : subLangPref)
        if (!target) return
        // Re-mount the textTrack by toggling .mode. The browser
        // (re)loads the cue source on first activation.
        for (let i = 0; i < video.textTracks.length; i++) {
            const tt = video.textTracks[i]
            if (tt.kind !== "subtitles") continue
            if (tt.language?.startsWith(target)) {
                tt.mode = "showing"
                setAutoShownTrack(true)
                break
            }
        }
    }, [subPrep?.state, subLangPref, autoShownTrack])

    // Next-episode lookup: only relevant for TV. We fetch the current
    // season to know whether there's a next episode, and the show
    // detail to learn the total seasons (in case we need to jump to
    // season N+1's episode 1).
    const router = useRouter()
    const showDetail = useTMDBDetail(nextEpisodeMediaId ? "tv" : "movie", nextEpisodeMediaId)
    const seasonDetail = useTMDBSeason(nextEpisodeMediaId, nextEpisodeSeason ?? null)

    type NextEpInfo = { season: number; episode: number; name: string }
    const nextEpisode = React.useMemo<NextEpInfo | null>(() => {
        if (!nextEpisodeMediaId || !nextEpisodeSeason || !nextEpisodeNumber) return null
        const epList = seasonDetail.data?.episodes ?? []
        // Same-season next episode?
        const sameSeason = epList.find(e => e.episode_number === nextEpisodeNumber + 1)
        if (sameSeason) {
            return {
                season: nextEpisodeSeason,
                episode: sameSeason.episode_number,
                name: sameSeason.name || `Épisode ${sameSeason.episode_number}`,
            }
        }
        // No more episodes this season — look for a next season.
        const seasons = (showDetail.data?.seasons ?? []).filter(s => s.season_number > nextEpisodeSeason)
        const nextSeason = seasons.sort((a, b) => a.season_number - b.season_number)[0]
        if (nextSeason && nextSeason.episode_count && nextSeason.episode_count > 0) {
            return {
                season: nextSeason.season_number,
                episode: 1,
                name: `S${nextSeason.season_number}E1`,
            }
        }
        return null
    }, [nextEpisodeMediaId, nextEpisodeSeason, nextEpisodeNumber, seasonDetail.data, showDetail.data])

    // Track time remaining and trigger the auto-next overlay in the
    // last 15 s of playback.
    const [showNextOverlay, setShowNextOverlay] = React.useState(false)
    const [countdownSec, setCountdownSec] = React.useState(10)
    React.useEffect(() => {
        if (!nextEpisode) return
        const video = videoRef.current
        if (!video) return
        const onTimeUpdate = () => {
            const dur = Number.isFinite(video.duration) ? video.duration : durationSec
            if (!dur || dur <= 0) return
            const remaining = dur - video.currentTime
            if (remaining <= 15 && remaining > 0) {
                setShowNextOverlay(true)
            } else {
                setShowNextOverlay(false)
            }
        }
        video.addEventListener("timeupdate", onTimeUpdate)
        return () => video.removeEventListener("timeupdate", onTimeUpdate)
    }, [nextEpisode, durationSec])

    // Countdown ticker while the overlay is visible.
    React.useEffect(() => {
        if (!showNextOverlay) {
            setCountdownSec(10)
            return
        }
        const handle = window.setInterval(() => {
            setCountdownSec(c => {
                if (c <= 1) {
                    window.clearInterval(handle)
                    return 0
                }
                return c - 1
            })
        }, 1000)
        return () => window.clearInterval(handle)
    }, [showNextOverlay])

    // Once the countdown hits 0, navigate to the next episode.
    React.useEffect(() => {
        if (!showNextOverlay) return
        if (countdownSec > 0) return
        if (!nextEpisode || !nextEpisodeMediaId) return
        const params = new URLSearchParams({
            id: String(nextEpisodeMediaId),
            type: "tv",
            season: String(nextEpisode.season),
            episode: String(nextEpisode.episode),
        })
        router.push(`/watch?${params.toString()}`)
    }, [countdownSec, showNextOverlay, nextEpisode, nextEpisodeMediaId, router])

    // Show a small corner pill while subs prep is in progress, plus a
    // brief "subs ready" toast when it transitions to ready. Lets the
    // user see something IS happening without blocking the video.
    const subPrepBusy =
        subPrep && (subPrep.state === "extracting" || subPrep.state === "translating" || subPrep.state === "picking")
    const [readyToastShown, setReadyToastShown] = React.useState(false)
    React.useEffect(() => {
        if (subPrep?.state !== "ready") return
        if (readyToastShown) return
        setReadyToastShown(true)
        // Auto-dismiss after a short delay.
        const handle = window.setTimeout(() => {}, 4000)
        return () => window.clearTimeout(handle)
    }, [subPrep?.state, readyToastShown])

    return (
        <div className="fixed inset-0 z-[100] bg-black flex flex-col">
            {/* Top bar — back button, title, transmux toggle, change-source. */}
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

            {/* Bottom-right corner: small sub-prep indicator. Disappears
                once subPrep.state === "ready" (then briefly shows a
                "ready" toast before disappearing). */}
            {subPrepBusy && (
                <div className="absolute bottom-20 right-4 z-10 bg-black/80 backdrop-blur-sm border border-white/10 rounded-lg px-3 py-2 text-xs text-white max-w-xs">
                    <div className="flex items-center gap-2">
                        <FiLoader className="size-3.5 animate-spin text-brand-400" />
                        <span className="font-semibold">
                            {t("watch.sub_prep_corner", "Sous-titres en préparation")}
                        </span>
                        <span className="font-mono tabular-nums text-[--muted]">
                            {(subPrep?.progress ?? 0).toFixed(1)} %
                        </span>
                    </div>
                </div>
            )}
            {subPrep?.state === "ready" && readyToastShown && (
                <div className="absolute bottom-20 right-4 z-10 bg-green-500/20 backdrop-blur-sm border border-green-500/40 rounded-lg px-3 py-2 text-xs text-green-200 animate-pulse">
                    {t("watch.sub_prep_corner_ready", "Sous-titres activés")}
                </div>
            )}

            {/* Next-episode auto-play overlay — appears in the final 15 s
                of playback when there IS a next episode. Counts down
                from 10 s, then navigates. User can dismiss or trigger
                immediately. */}
            {showNextOverlay && nextEpisode && (
                <div className="absolute bottom-24 right-4 z-20 bg-black/90 backdrop-blur-sm border border-white/10 rounded-lg p-4 max-w-sm shadow-2xl">
                    <p className="text-[--muted] text-xs uppercase tracking-wider font-semibold mb-1">
                        {t("watch.next_episode_label", "Prochain épisode")}
                    </p>
                    <p className="text-white font-bold text-sm mb-3 line-clamp-2">
                        S{nextEpisode.season}E{nextEpisode.episode}
                        {nextEpisode.name ? ` · ${nextEpisode.name}` : ""}
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                const params = new URLSearchParams({
                                    id: String(nextEpisodeMediaId),
                                    type: "tv",
                                    season: String(nextEpisode.season),
                                    episode: String(nextEpisode.episode),
                                })
                                router.push(`/watch?${params.toString()}`)
                            }}
                            className="flex-1 px-3 py-2 rounded-md bg-white text-black hover:bg-white/90 font-bold text-xs"
                        >
                            {t("watch.next_play_now", "Lancer")} · {countdownSec}s
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowNextOverlay(false)}
                            className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/20 text-white text-xs font-semibold"
                        >
                            {t("common.cancel", "Annuler")}
                        </button>
                    </div>
                </div>
            )}

            {/* src is set imperatively in the effect above — either
                directly (native HTTP playback) or via Hls.attachMedia
                pointing at the backend's HLS playlist. The <track>
                children mount the embedded subtitle streams the backend
                discovered during ffprobe. The browser surfaces them
                through the native CC menu (a "subtitles" icon on the
                control bar). */}
            <video
                ref={videoRef}
                autoPlay
                controls
                playsInline
                className="w-full h-full object-contain"
                onError={(e) => {
                    // Browser MediaError codes:
                    //   1 = ABORTED, 2 = NETWORK, 3 = DECODE, 4 = SRC_NOT_SUPPORTED.
                    // Code 3 + 4 are unrecoverable — typically XviD/DivX
                    // releases that ffprobe failed on too. Auto-fallback
                    // to the next ranked release rather than leaving the
                    // user staring at a frozen player.
                    const err = (e.currentTarget as HTMLVideoElement).error
                    console.error("[Notflix] video error", err?.code, err?.message)
                    if (err && (err.code === 3 || err.code === 4)) {
                        onFatalError()
                    }
                }}
            >
                {sessionId && resolveSubtitleTracks(subtitles, subLangPref).map(track => {
                    const route = track.source === "external" ? "ext" : "sub"
                    const base = `/api/v1/stream/hls/${sessionId}/${route}_${track.index}.vtt`
                    return (
                        <track
                            key={`${track.source}-${track.index}-${track.translateTo ?? ""}`}
                            kind="subtitles"
                            src={track.translateTo ? `${base}?translateTo=${track.translateTo}` : base}
                            srcLang={track.srcLang}
                            label={track.label}
                            // Never `default` — Chrome eagerly loads default
                            // tracks at mount time, and if the backend cache
                            // isn't warm yet that initial fetch fails and the
                            // track stays disabled forever. We activate it
                            // ourselves via textTracks[i].mode = "showing"
                            // after subPrep.state becomes ready.
                        />
                    )
                })}
            </video>
        </div>
    )
}

/** Pick a MIME type the browser's canPlayType understands from the
 *  comma-joined container list ffprobe returns. Returns "" when none
 *  of the listed format names map to a known MIME — in which case the
 *  caller should force HLS transmux. */
function mimeForContainer(container: string): string {
    const c = container.toLowerCase()
    // ffprobe joins multiple compatible format ids with commas, so we
    // substring-match instead of strict-equals.
    if (c.includes("mp4") || c.includes("mov") || c.includes("m4a") || c.includes("m4v")) {
        return "video/mp4"
    }
    if (c.includes("webm")) {
        return "video/webm"
    }
    // MKV is universally probed as "matroska,webm". Some browsers handle
    // it (Chrome on macOS, Firefox); many don't. We let canPlayType
    // arbitrate — if it says "" the caller forces HLS.
    if (c.includes("matroska")) {
        return "video/x-matroska"
    }
    // AVI, WMV, FLV, … — browsers don't decode any of these.
    return ""
}

/** Best-effort codec strings for canPlayType. We pick conservative
 *  profile/level pairs that cover 99% of releases (H.264 high level 4
 *  for 1080p, AAC LC 2.0). Real-world releases use higher levels too,
 *  but canPlayType isn't strict about that — "probably" usually means
 *  "the codec, any common profile". */
function codecStringFor(videoCodec: string, audioCodec: string): string {
    const parts: string[] = []
    switch (videoCodec.toLowerCase()) {
        case "h264":
        case "avc":
            parts.push("avc1.640028")
            break
        case "hevc":
        case "h265":
            parts.push("hvc1.1.6.L120.B0")
            break
        case "vp9":
            parts.push("vp09.00.50.08")
            break
        case "av1":
            parts.push("av01.0.05M.08")
            break
        case "vp8":
            parts.push("vp8")
            break
        // xvid/mpeg4 ASP/wmv/divx → no canPlayType match, browser
        // will refuse. Leave empty so the MIME stays plain
        // "video/mp4" (or whatever) and canPlayType says "".
    }
    switch (audioCodec.toLowerCase()) {
        case "aac":
            parts.push("mp4a.40.2")
            break
        case "mp3":
            parts.push("mp4a.40.34") // MP3 in MP4 container
            break
        case "opus":
            parts.push("opus")
            break
        case "vorbis":
            parts.push("vorbis")
            break
        // AC3/EAC3/DTS/TrueHD/FLAC → not browser-decodable on most
        // platforms. Skip to keep canPlayType honest.
    }
    return parts.join(",")
}

/** True iff the browser advertises native playback for this exact
 *  combination of container + video codec + audio codec. */
function canBrowserPlayDirect(container: string, videoCodec: string, audioCodec: string): boolean {
    if (typeof document === "undefined") return false
    const mime = mimeForContainer(container)
    if (!mime) return false
    const codecs = codecStringFor(videoCodec, audioCodec)
    const full = codecs ? `${mime}; codecs="${codecs}"` : mime
    const v = document.createElement("video")
    const verdict = v.canPlayType(full)
    // Only "probably" is a confident yes. "maybe" is the browser
    // hedging — often it can't actually play the audio side even
    // though the container is fine. Force HLS on "maybe" to avoid
    // silent playback.
    return verdict === "probably"
}

/** Map ffprobe's ISO-639-2 (3-letter) tags to the 2-letter BCP-47 codes
 *  browsers prefer for <track srclang>. Falls through unchanged for
 *  tags we don't know about — the browser still accepts them as opaque. */
function normaliseSubLang(raw: string): string {
    const m: Record<string, string> = {
        fre: "fr", fra: "fr", fr: "fr",
        eng: "en", en: "en",
        jpn: "ja", ja: "ja",
        spa: "es", es: "es",
        ger: "de", deu: "de", de: "de",
        ita: "it", it: "it",
        por: "pt", pt: "pt",
        ara: "ar", ar: "ar",
        chi: "zh", zho: "zh", zh: "zh",
        kor: "ko", ko: "ko",
        rus: "ru", ru: "ru",
        nld: "nl", dut: "nl", nl: "nl",
    }
    const k = raw.toLowerCase()
    return m[k] ?? k
}

const subLangNames: Record<string, string> = {
    fr: "Français",
    en: "English",
    ja: "日本語",
    es: "Español",
    de: "Deutsch",
    it: "Italiano",
    pt: "Português",
    ar: "العربية",
    zh: "中文",
    ko: "한국어",
    ru: "Русский",
    nl: "Nederlands",
}

/** Human-readable label shown in the CC menu. */
function subtitleLabel(track: SubtitleTrack, override?: string): string {
    const lang = override ?? normaliseSubLang(track.language)
    const base = subLangNames[lang] || track.language || "?"
    if (track.title && track.title.toLowerCase() !== base.toLowerCase()) {
        return `${base} · ${track.title}`
    }
    return base
}

type ResolvedTrack = {
    source: "embedded" | "external"
    index: number
    srcLang: string
    label: string
    isDefault: boolean
    /** When set, the backend will run the source VTT through Claude
     *  before serving it. Mounted as ?translateTo=<code>. */
    translateTo?: string
}

/**
 * resolveSubtitleTracks picks which subtitle entries the player exposes
 * to the user, and decides whether to ask the backend for an on-the-fly
 * translation.
 *
 * Strategy:
 *   1. Build one <track> per supported native subtitle (no translation
 *      query, plain srcLang from the source).
 *   2. If the user picked a language pref (other than "off" / "auto")
 *      and no native track already serves it, ADD one translated track:
 *      pick the most useful native source (English first if available,
 *      else the first supported track) and translate it via Claude.
 *   3. Default selection: the user's preferred language if present (or
 *      its translation), else French if present, else nothing.
 *   4. "off" → no <track> rendered at all.
 */
function resolveSubtitleTracks(
    subs: SubtitleTrack[],
    pref: SubtitleLangPref,
): ResolvedTrack[] {
    if (pref === "off") return []

    const supported = subs.filter(s => s.supported)
    if (supported.length === 0) return []

    // Native tracks first, no translation.
    const native: ResolvedTrack[] = supported.map(s => {
        const lang = normaliseSubLang(s.language)
        return {
            source: s.source,
            index: s.index,
            srcLang: lang || "und",
            label: subtitleLabel(s),
            isDefault: false,
        }
    })

    // Find the requested language in the existing native tracks.
    const wantLang = pref === "auto" ? "fr" : pref
    const nativeMatch = native.find(t => t.srcLang === wantLang)

    const tracks: ResolvedTrack[] = [...native]

    if (!nativeMatch && pref !== "auto") {
        // No native track for the requested language — ask Claude.
        // Pick English as the source if available (best translation
        // input), else the first supported native track.
        const sourceTrack =
            supported.find(s => normaliseSubLang(s.language) === "en") ?? supported[0]
        tracks.push({
            source: sourceTrack.source,
            index: sourceTrack.index,
            srcLang: wantLang,
            label: `${subLangNames[wantLang] || wantLang} (traduit)`,
            isDefault: false,
            translateTo: wantLang,
        })
    }

    // Default-track selection.
    const defaultLang = pref === "auto" ? "fr" : pref
    const defaultTrack =
        tracks.find(t => t.srcLang === defaultLang && !!t.translateTo) ??
        tracks.find(t => t.srcLang === defaultLang) ??
        // Fallback: first track (typically French if the user kept "auto"
        // with a non-French source; better than nothing).
        tracks[0]
    if (defaultTrack) {
        defaultTrack.isDefault = true
    }

    return tracks
}
