/**
 * Notflix detail modal — opens when a card is clicked from the home / lists
 * / search grid. Shows TMDB metadata, lets the user pick playback prefs,
 * and (for TV series) the season + episode via a Netflix-style episode list.
 *
 * Click target → /watch with the right query params.
 */
import { Button, IconButton } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Modal } from "@/components/ui/modal"
import { Skeleton } from "@/components/ui/skeleton"
import { useRouter } from "@/lib/navigation"
import {
    AUDIO_OPTIONS,
    QUALITY_OPTIONS,
    SUBTITLE_LANG_OPTIONS,
    useAudioPref,
    useQualityPref,
    useSubPrepMode,
    useSubtitleLangPref,
} from "@/lib/preferences"
import {
    listEntryKey,
    useActiveProfileId,
    useActiveProfileListStatusMap,
    useMarkSeriesWatched,
    useProfileListActions,
} from "@/lib/profiles/profiles"
import {
    mediaTypeOf,
    TMDBCastMember,
    TMDBEpisode,
    titleOf,
    tmdbImage,
    useTMDBDetail,
    useTMDBSeason,
    yearOf,
} from "@/lib/tmdb"
import { langLabel, useLocalAudioLang, useLocalLibrary, type LocalFile } from "@/app/(main)/_features/netflix/netflix-local-library"
import { useSearchMovie, type Release } from "@/lib/notflix-api"
import { useNetflixPersonModal } from "@/app/(main)/_features/netflix/netflix-person-modal"
import { atom, useAtom, useSetAtom } from "jotai"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiCheck, BiPlay, BiPlus, BiX } from "react-icons/bi"
import { LuUpload } from "react-icons/lu"
import { TorrentSourceDialog, type TorrentSourceContext } from "@/app/(main)/_features/netflix/torrent-source-dialog"

type ModalTarget = {
    id: number
    type: "movie" | "tv"
    /**
     * Optional season to pre-select on open. Used when re-opening the modal
     * from /watch's back button so the user returns to the same season they
     * picked the episode from, not the show's default (S01).
     */
    initialSeason?: number
} | null

const __notflixDetailModalAtom = atom<ModalTarget>(null)

export function useNetflixDetailModal() {
    const set = useSetAtom(__notflixDetailModalAtom)
    return {
        openDetail: (
            mediaId: number,
            mediaType: "movie" | "tv" = "movie",
            initialSeason?: number,
        ) => set({ id: mediaId, type: mediaType, initialSeason }),
        closeDetail: () => set(null),
    }
}

export function NetflixDetailModal() {
    const [target, setTarget] = useAtom(__notflixDetailModalAtom)
    const open = target !== null

    return (
        <Modal
            open={open}
            onOpenChange={(v) => { if (!v) setTarget(null) }}
            overlayClass="!z-[70]"
            contentClass="!max-w-5xl !p-0 !rounded-xl overflow-hidden bg-[#0a0a0a] border-white/5"
            hideCloseButton
        >
            {open && (
                <>
                    <IconButton
                        intent="gray-subtle"
                        size="md"
                        className={cn(
                            "absolute z-[80] rounded-full bg-black/80 hover:bg-black !text-white",
                            "right-3 top-3",
                            "size-11 lg:size-9",
                        )}
                        icon={<BiX className="text-2xl" />}
                        onClick={() => setTarget(null)}
                        aria-label="Close"
                    />
                    <Body target={target!} />
                </>
            )}
        </Modal>
    )
}

function Body({ target }: { target: NonNullable<ModalTarget> }) {
    const { t } = useTranslation()
    const router = useRouter()
    const { closeDetail } = useNetflixDetailModal()
    const { data, isLoading } = useTMDBDetail(target.type, target.id)
    const [quality, setQuality] = useQualityPref()
    const [audio, setAudio] = useAudioPref()
    const [subLang, setSubLang] = useSubtitleLangPref()
    const [subPrepMode, setSubPrepMode] = useSubPrepMode()

    // Local-library awareness. If the title we're showing has files on
    // disk, the Lecture button + episode rows route to /watch?localId
    // instead of triggering the Prowlarr+TorBox flow. Without this, the
    // user clicks a card on the Bibliothèque locale rail → modal →
    // Lecture → and the player starts searching torrents for a file
    // that's already there, which is both confusing and wasteful.
    const { data: allLocal } = useLocalLibrary()
    const localFilesForTitle = React.useMemo(() => {
        if (!allLocal || allLocal.length === 0) return [] as LocalFile[]
        return allLocal.filter(f => f.tmdbId === target.id)
    }, [allLocal, target.id])
    const hasLocal = localFilesForTitle.length > 0

    // TV series: track which season we're showing in the episode list.
    // Episode is no longer a separate piece of state — the user clicks an
    // episode row to launch it. The big "Lecture" button still launches
    // episode 1 of the current season as a sensible default.
    const seasons = React.useMemo(() => {
        if (target.type !== "tv") return [] as NonNullable<typeof data>["seasons"]
        return (data?.seasons ?? []).filter(s => s.season_number > 0)
    }, [target.type, data?.seasons])
    // Honour target.initialSeason on open — used by /watch's back button
    // so the user returns to the same season they were browsing, not S01.
    const [selectedSeason, setSelectedSeason] = React.useState<number | null>(
        target.initialSeason ?? null,
    )

    // Torrent source dialog. Opened by the ".torrent" button — lets
    // the user feed a .torrent file directly instead of going through
    // the Prowlarr auto-search.
    const [torrentDialogOpen, setTorrentDialogOpen] = React.useState(false)

    React.useEffect(() => {
        if (target.type !== "tv") return
        if (selectedSeason != null) return
        if (seasons.length === 0) return
        setSelectedSeason(seasons[0].season_number)
    }, [target.type, seasons, selectedSeason])

    // Speculative TorBox prefetch — if the user dwells on the modal for
    // 5 s, ask TorBox to start peer-fetching the best non-cached release
    // ahead of the explicit Play click. By the time they actually click
    // (often 10-60 s later, after reading the synopsis), part of the file
    // is already on TorBox's CDN → stream starts much faster.
    //
    // Only fires for movies; TV episode selection is too variable.
    // Computed defensively (with optional chaining) because hooks must
    // run on every render BEFORE the loading early-return below.
    const prefetchTitle = data && mediaTypeOf(data, target.type) === "movie" ? titleOf(data) : ""
    const prefetchYear = data ? yearOf(data) : undefined
    useTorBoxPrefetch(prefetchTitle, prefetchYear)

    if (isLoading || !data) return <BodySkeleton />

    const type = mediaTypeOf(data, target.type)
    const banner = tmdbImage("original", data.backdrop_path) || tmdbImage("w780", data.poster_path)
    const title = titleOf(data)
    const year = yearOf(data)
    const overview = data.overview || ""
    const genres = data.genres?.map(g => g.name) ?? []
    const score = data.vote_average

    // Build the /watch URL with current prefs + (for TV) the requested
    // season/episode. Movies omit the season/episode params entirely.
    //
    // Local-library short-circuit: if we already have the requested
    // (movie OR episode) on disk, route via /watch?localId=N. The watch
    // page detects localId and skips the entire Prowlarr+TorBox flow.
    // Without this short-circuit, opening a film from the local rail
    // would (re-)search torrents which is both wasteful and confusing.
    const buildWatchUrl = (season?: number, episode?: number) => {
        const localId = pickLocalFileId(localFilesForTitle, type, season, episode)
        if (localId != null) {
            return `/watch?localId=${localId}`
        }
        const params = new URLSearchParams({ id: String(data.id), type })
        if (quality !== "auto") params.set("quality", quality)
        if (audio !== "auto") params.set("audio", audio)
        if (subLang !== "fr") params.set("sub", subLang)
        if (type === "tv" && season != null && episode != null) {
            params.set("season", String(season))
            params.set("episode", String(episode))
        }
        return `/watch?${params.toString()}`
    }

    const onPlayMain = () => {
        closeDetail()
        if (type === "tv" && selectedSeason != null) {
            router.push(buildWatchUrl(selectedSeason, 1))
        } else {
            router.push(buildWatchUrl())
        }
    }

    const onPlayEpisode = (season: number, episode: number) => {
        closeDetail()
        router.push(buildWatchUrl(season, episode))
    }

    // Build the context for the .torrent dialog. For TV we pass the
    // currently-selected season + episode 1 by default (the user can
    // still pick any file from the picker).
    const torrentContext: TorrentSourceContext = {
        tmdbId: data.id,
        mediaType: type,
        title,
        posterPath: data.poster_path ?? "",
        backdropPath: data.backdrop_path ?? "",
        season: type === "tv" && selectedSeason != null ? selectedSeason : undefined,
        episode: type === "tv" && selectedSeason != null ? 1 : undefined,
    }

    return (
        <>
        <div className="max-h-[90vh] sm:max-h-[85vh] overflow-y-auto">
            {/* Hero banner */}
            <div className="relative w-full aspect-[4/3] sm:aspect-[16/9] lg:aspect-[16/8] bg-black">
                {banner && (
                    <img
                        src={banner}
                        alt={title}
                        className="absolute inset-0 w-full h-full object-cover object-center"
                    />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/30 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6 lg:p-10 space-y-3 lg:space-y-4">
                    <h1 className="text-2xl sm:text-3xl lg:text-5xl font-extrabold text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)] max-w-2xl leading-tight">
                        {title}
                    </h1>
                    <div className="flex items-center gap-3 flex-wrap">
                        <Button
                            size="md"
                            onClick={onPlayMain}
                            disabled={type === "tv" && selectedSeason == null}
                            className="bg-white !text-black hover:!bg-white/90 font-bold rounded-md px-6 lg:px-8 lg:!h-12 lg:!text-base disabled:opacity-50"
                            leftIcon={<BiPlay className="text-xl sm:text-2xl" />}
                        >
                            {type === "tv" && selectedSeason != null
                                ? `${t("modal.play", "Lecture")} · S${selectedSeason}E1`
                                : t("modal.play", "Lecture")}
                        </Button>
                        {/* "LOCAL" badge — surfaces when at least one file
                            for this title is on disk. Tells the user the
                            Lecture button will play from /api/v1/local-library
                            instead of triggering a Prowlarr search.
                            For movies (single file) we also fetch the audio
                            track 0 language and append it ("· FR" / "· VO"). */}
                        {hasLocal && (
                            <MovieLocalBadge
                                isMovie={type === "movie"}
                                tvCount={type === "tv" ? localFilesForTitle.length : 0}
                                localId={type === "movie" ? localFilesForTitle[0]?.id : undefined}
                            />
                        )}

                        {/* "Ma liste" toggle — adds/removes from the active
                            profile's list. Only rendered when a profile is
                            selected; in single-user mode there's nothing
                            to persist against. */}
                        <ListToggleButton
                            tmdbId={data.id}
                            mediaType={type}
                            title={title}
                            posterPath={data.poster_path ?? ""}
                        />

                        {/* Quality + audio prefs — persisted in localStorage so
                            the choice survives between films. /watch reads
                            them from the URL params. */}
                        <PrefSelect
                            label={t("modal.quality", "Qualité")}
                            value={quality}
                            options={QUALITY_OPTIONS}
                            onChange={(v) => setQuality(v as typeof quality)}
                        />
                        <PrefSelect
                            label={t("modal.audio", "Langue")}
                            value={audio}
                            options={AUDIO_OPTIONS}
                            onChange={(v) => setAudio(v as typeof audio)}
                        />
                        <PrefSelect
                            label={t("modal.subtitles", "Sous-titres")}
                            value={subLang}
                            options={SUBTITLE_LANG_OPTIONS}
                            onChange={(v) => setSubLang(v as typeof subLang)}
                        />
                        {subLang !== "off" && (
                            <PrefSelect
                                label={t("modal.sub_prep_mode", "Préparation")}
                                value={subPrepMode}
                                options={[
                                    { value: "wait", label: t("modal.sub_prep_wait", "Attendre les sous-titres") },
                                    { value: "background", label: t("modal.sub_prep_background", "Lecture immédiate") },
                                ]}
                                onChange={(v) => setSubPrepMode(v as typeof subPrepMode)}
                            />
                        )}

                        {/* Custom .torrent source — bypasses Prowlarr
                            entirely. Useful when the auto-search picks
                            a bad release or when you want to use a
                            torrent you already have on disk. */}
                        <button
                            type="button"
                            onClick={() => setTorrentDialogOpen(true)}
                            className={cn(
                                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md",
                                "text-xs font-semibold",
                                "bg-white/10 hover:bg-white/15 text-white/80 hover:text-white",
                                "border border-white/10",
                                "transition-colors",
                            )}
                            title={t("modal.torrent_source", "Lance depuis un fichier .torrent que tu fournis")}
                        >
                            <LuUpload className="size-3.5" />
                            {t("modal.torrent_source_btn", ".torrent")}
                        </button>

                        {/* TV-only: bulk mark every episode of every
                            season as watched. Hidden in single-user
                            mode since the action targets the active
                            profile's history. */}
                        {type === "tv" && seasons.length > 0 && (
                            <MarkSeriesWatchedButton
                                tmdbId={data.id}
                                title={title}
                                posterPath={data.poster_path ?? ""}
                                backdropUrl={data.backdrop_path ?? ""}
                                seasons={seasons}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* Synopsis + meta */}
            <div className="p-4 sm:p-6 lg:p-10 space-y-6 lg:space-y-8">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
                    <div className="lg:col-span-2 space-y-3">
                        <div className="flex items-center gap-3 flex-wrap text-sm text-[--muted]">
                            {year && <span className="text-white">{year}</span>}
                            {type === "tv" && data.number_of_seasons != null && (
                                <span>
                                    {data.number_of_seasons} {t("modal.seasons", "saisons")}
                                </span>
                            )}
                            {type === "movie" && data.runtime != null && (
                                <span>{data.runtime} min</span>
                            )}
                            {score != null && score > 0 && (
                                <span className="px-2 py-0.5 rounded bg-brand-500/20 text-brand-300 font-semibold text-xs">
                                    {score.toFixed(1)}/10
                                </span>
                            )}
                        </div>
                        <p className="text-gray-200 leading-relaxed text-sm lg:text-base">
                            {overview}
                        </p>
                    </div>
                    <div className="space-y-2 text-sm">
                        {genres.length > 0 && (
                            <div>
                                <span className="text-[--muted]">{t("modal.genres", "Genres")}: </span>
                                <span className="text-white">{genres.join(", ")}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* TV episode list — only for series with at least one season */}
            {type === "tv" && seasons.length > 0 && selectedSeason != null && (
                <EpisodeList
                    tvId={data.id}
                    seasons={seasons.map(s => ({
                        season_number: s.season_number,
                        name: s.name,
                        episode_count: s.episode_count,
                    }))}
                    selectedSeason={selectedSeason}
                    onChangeSeason={setSelectedSeason}
                    onPickEpisode={onPlayEpisode}
                    localFiles={localFilesForTitle}
                />
            )}

            {/* Cast carousel — TMDB credits.cast surfaced as a horizontal
                row of photos + names + characters. Click → open the
                NetflixPersonModal with the actor's filmography. */}
            {data.credits?.cast && data.credits.cast.length > 0 && (
                <CastCarousel cast={data.credits.cast} />
            )}
        </div>
        <TorrentSourceDialog
            open={torrentDialogOpen}
            onClose={() => setTorrentDialogOpen(false)}
            context={torrentContext}
        />
        </>
    )
}

/** pickLocalFileId chooses which on-disk file (if any) covers a given
 *  TMDB id + (season, episode) tuple. Used by the detail modal's
 *  buildWatchUrl to short-circuit the Prowlarr+TorBox flow when we
 *  already have the file locally.
 *
 *  - Movies: takes the first matching row (callers pre-filter by tmdbId).
 *  - TV: prefers an exact (season, episode) match, falls back to any
 *    file from the same season, otherwise returns null so the cloud
 *    flow can still launch a search.
 *
 *  Returns null when no usable local file exists — the caller treats
 *  that as "no local copy, behave as before". */
/** "LOCAL" badge for the modal — shows the audio language for
 *  single-file movies, and the episode count for TV shows. */
function MovieLocalBadge({
    isMovie,
    tvCount,
    localId,
}: {
    isMovie: boolean
    tvCount: number
    localId?: number
}) {
    const { t } = useTranslation()
    const { data: audioLangCode } = useLocalAudioLang(localId, isMovie)
    const langLbl = isMovie ? langLabel(audioLangCode) : null
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-md",
                "bg-emerald-500/15 border border-emerald-500/40 text-emerald-300",
                "text-[10px] font-bold uppercase tracking-wider",
            )}
            title={t("modal.local_available", "Disponible dans ta bibliothèque locale")}
        >
            <span className="size-1.5 rounded-full bg-emerald-400" />
            {t("modal.local_badge", "Local")}
            {langLbl && (
                <span className="text-emerald-300/85 font-normal">· {langLbl}</span>
            )}
            {!isMovie && tvCount > 1 && (
                <span className="text-emerald-300/70 font-normal">
                    · {tvCount} ép.
                </span>
            )}
        </span>
    )
}

function pickLocalFileId(
    files: LocalFile[],
    type: "movie" | "tv",
    season?: number,
    episode?: number,
): number | null {
    if (!files || files.length === 0) return null
    if (type === "movie") {
        return files[0].id
    }
    if (season != null && episode != null) {
        const exact = files.find(f => f.season === season && f.episode === episode)
        if (exact) return exact.id
    }
    if (season != null) {
        const inSeason = files.find(f => f.season === season)
        if (inSeason) return inSeason.id
    }
    return null
}

// ---------------------------------------------------------------------------
// Cast carousel
// ---------------------------------------------------------------------------

function CastCarousel({ cast }: { cast: TMDBCastMember[] }) {
    const { t } = useTranslation()
    const { openPerson } = useNetflixPersonModal()
    // Cap at 30 — anything more is overwhelming in a horizontal row.
    const visible = cast.slice(0, 30)
    if (visible.length === 0) return null
    return (
        <section className="px-5 sm:px-8 lg:px-12 pb-6 space-y-3">
            <h3 className="text-base lg:text-lg font-bold text-white tracking-tight">
                {t("modal.cast", "Casting")}
            </h3>
            <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-2 -mx-1 px-1">
                {visible.map(member => {
                    const img = tmdbImage("w185", member.profile_path)
                    return (
                        <button
                            key={member.id}
                            type="button"
                            onClick={() => openPerson(member.id)}
                            className={cn(
                                "shrink-0 w-24 lg:w-28 text-left",
                                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 rounded-md",
                                "group",
                            )}
                            aria-label={member.name}
                        >
                            <div className="w-24 h-24 lg:w-28 lg:h-28 rounded-full overflow-hidden bg-white/5 border border-white/10 mx-auto transition-transform group-hover:scale-105">
                                {img ? (
                                    <img src={img} alt={member.name} loading="lazy" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-white/40 text-xs font-bold">
                                        {member.name.split(" ").map(s => s[0]).join("").slice(0, 2)}
                                    </div>
                                )}
                            </div>
                            <p className="mt-1.5 text-[11px] text-white font-semibold text-center line-clamp-1">
                                {member.name}
                            </p>
                            {member.character && (
                                <p className="text-[10px] text-[--muted] text-center line-clamp-1">
                                    {member.character}
                                </p>
                            )}
                        </button>
                    )
                })}
            </div>
        </section>
    )
}

// ---------------------------------------------------------------------------
// Episode list (Netflix-style)
// ---------------------------------------------------------------------------

type SeasonSummary = { season_number: number; name: string; episode_count: number }

function EpisodeList({
    tvId,
    seasons,
    selectedSeason,
    onChangeSeason,
    onPickEpisode,
    localFiles,
}: {
    tvId: number
    seasons: SeasonSummary[]
    selectedSeason: number
    onChangeSeason: (n: number) => void
    onPickEpisode: (season: number, episode: number) => void
    /** Files on disk for the same TMDB show — used to tag rows with
     *  a "Local" badge. Empty array when nothing is scanned. */
    localFiles: LocalFile[]
}) {
    const { t } = useTranslation()
    const { data: seasonDetail, isLoading, isFetching } = useTMDBSeason(tvId, selectedSeason)
    const episodes = seasonDetail?.episodes ?? []
    const currentSeasonName =
        seasons.find(s => s.season_number === selectedSeason)?.name ?? `Saison ${selectedSeason}`

    return (
        <section className="px-4 sm:px-6 lg:px-10 pb-8 lg:pb-12 space-y-4">
            <header className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-xl lg:text-2xl font-bold text-white">
                    {t("modal.episodes", "Épisodes")}
                </h2>
                {seasons.length > 1 ? (
                    <SeasonSelect
                        seasons={seasons}
                        value={selectedSeason}
                        onChange={onChangeSeason}
                    />
                ) : (
                    <span className="text-sm text-[--muted]">{currentSeasonName}</span>
                )}
            </header>

            {/* Episode rows. We render skeletons during the very first fetch
                so the modal doesn't flash an empty section. */}
            {(isLoading || (isFetching && episodes.length === 0)) ? (
                <ul className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <EpisodeRowSkeleton key={i} />
                    ))}
                </ul>
            ) : episodes.length === 0 ? (
                <p className="text-center py-8 text-[--muted] text-sm">
                    {t("modal.no_episodes", "Aucun épisode disponible pour cette saison.")}
                </p>
            ) : (
                <ul className="-mx-1">
                    {episodes.map(ep => {
                        // O(n × m) but episode lists are small (~24 max)
                        // and localFiles is filtered to this show.
                        const localFile = localFiles.find(
                            f => f.season === selectedSeason && f.episode === ep.episode_number,
                        )
                        return (
                            <li key={ep.id}>
                                <EpisodeRow
                                    episode={ep}
                                    isLocal={!!localFile}
                                    localId={localFile?.id}
                                    onClick={() => onPickEpisode(selectedSeason, ep.episode_number)}
                                />
                            </li>
                        )
                    })}
                </ul>
            )}
        </section>
    )
}

function EpisodeRow({
    episode,
    onClick,
    isLocal,
    localId,
}: {
    episode: TMDBEpisode
    onClick: () => void
    isLocal?: boolean
    localId?: number
}) {
    const { t } = useTranslation()
    const thumb = tmdbImage("w300", episode.still_path)
    // Probe ONLY when the row is local — avoids a useless /probe call
    // for the 23 of 24 episodes that aren't on disk.
    const { data: audioLangCode } = useLocalAudioLang(localId, !!isLocal)
    const langLbl = langLabel(audioLangCode)
    // Mark episodes whose air_date is still in the future — they exist in
    // TMDB's catalogue but Prowlarr won't have a release for them yet.
    const airDate = episode.air_date ? new Date(episode.air_date) : null
    const isUpcoming = !!airDate && airDate.getTime() > Date.now()

    return (
        <button
            type="button"
            onClick={onClick}
            disabled={isUpcoming}
            className={cn(
                "group w-full text-left flex items-start gap-3 sm:gap-4 px-2 sm:px-3 py-3",
                "border-b border-white/5 hover:bg-white/[0.04] transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 rounded-md",
                isUpcoming && "opacity-50 cursor-not-allowed hover:bg-transparent",
            )}
        >
            <span className="text-2xl sm:text-3xl font-bold text-[--muted] w-8 sm:w-10 text-center shrink-0 self-center">
                {episode.episode_number}
            </span>

            <div className="relative aspect-video w-[110px] sm:w-[140px] lg:w-[180px] shrink-0 rounded-md overflow-hidden bg-black">
                {thumb ? (
                    <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full bg-white/5" />
                )}
                {/* Play overlay on hover (desktop only — feels janky on touch) */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 flex items-center justify-center transition-colors">
                    <BiPlay className="size-8 lg:size-10 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                {episode.runtime != null && episode.runtime > 0 && (
                    <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/80 text-white text-[10px] font-semibold">
                        {episode.runtime} min
                    </span>
                )}
                {/* "LOCAL" badge — top-left. Tells the user this episode
                    will play from disk instead of triggering Prowlarr.
                    Matches the green-on-dark style of the "Local" pill
                    next to the main Lecture button. */}
                {isLocal && (
                    <span
                        className={cn(
                            "absolute top-1 left-1 inline-flex items-center gap-1",
                            "px-1.5 py-0.5 rounded",
                            "bg-emerald-500/85 text-white",
                            "text-[9px] font-bold uppercase tracking-wider",
                            "shadow-[0_1px_2px_rgba(0,0,0,0.6)]",
                        )}
                        title={t("modal.local_available", "Disponible dans ta bibliothèque locale")}
                    >
                        <span className="size-1 rounded-full bg-white" />
                        {t("modal.local_badge", "Local")}
                        {langLbl && (
                            <span className="font-normal text-white/85">· {langLbl}</span>
                        )}
                    </span>
                )}
            </div>

            <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-white font-semibold text-sm sm:text-base line-clamp-1">
                        {episode.name || `Épisode ${episode.episode_number}`}
                    </h3>
                    {isUpcoming && airDate && (
                        <span className="text-[10px] uppercase tracking-wide text-brand-400 font-semibold shrink-0">
                            {airDate.toLocaleDateString("fr-FR", {
                                day: "2-digit",
                                month: "short",
                                year: "numeric",
                            })}
                        </span>
                    )}
                </div>
                {episode.overview && (
                    <p className="text-[--muted] text-xs sm:text-sm line-clamp-2 lg:line-clamp-3">
                        {episode.overview}
                    </p>
                )}
            </div>
        </button>
    )
}

function EpisodeRowSkeleton() {
    return (
        <div className="flex items-start gap-3 sm:gap-4 px-2 sm:px-3 py-3 border-b border-white/5">
            <Skeleton className="w-8 h-6 shrink-0 mt-2" />
            <Skeleton className="aspect-video w-[110px] sm:w-[140px] lg:w-[180px] shrink-0 rounded-md" />
            <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
            </div>
        </div>
    )
}

/**
 * Season dropdown used at the top of the episode list. Styled to look like
 * a Netflix "boxed" picker — pill with chevron, native <select> overlay.
 */
function SeasonSelect({
    seasons,
    value,
    onChange,
}: {
    seasons: SeasonSummary[]
    value: number
    onChange: (n: number) => void
}) {
    const current = seasons.find(s => s.season_number === value)
    return (
        <label className="relative inline-flex">
            <span
                className={cn(
                    "inline-flex items-center justify-between gap-3 min-w-[12rem]",
                    "bg-white/5 hover:bg-white/10 border border-white/15 rounded-md",
                    "px-3 py-2 text-white text-sm font-semibold",
                    "transition-colors",
                )}
            >
                {current?.name ?? `Saison ${value}`}
                <svg className="size-4 opacity-70" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
            </span>
            <select
                value={value}
                onChange={(e) => onChange(parseInt(e.target.value, 10))}
                className="absolute inset-0 opacity-0 cursor-pointer"
                aria-label="Saison"
            >
                {seasons.map(s => (
                    <option key={s.season_number} value={s.season_number}>
                        {s.name || `Saison ${s.season_number}`} ({s.episode_count})
                    </option>
                ))}
            </select>
        </label>
    )
}

// ---------------------------------------------------------------------------
// Generic compact pref picker (Quality / Audio in the hero CTA row)
// ---------------------------------------------------------------------------

function PrefSelect<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string
    value: T
    options: { value: T; label: string }[]
    onChange: (v: T) => void
}) {
    const current = options.find(o => o.value === value)
    return (
        <label className="relative inline-flex flex-col gap-0.5 text-left">
            <span className="text-[10px] uppercase tracking-wider text-[--muted] font-semibold">
                {label}
            </span>
            <span
                className={cn(
                    "inline-flex items-center justify-between gap-2 min-w-[10rem]",
                    "bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded-md",
                    "px-3 py-2 text-white text-sm font-semibold",
                    "transition-colors",
                )}
            >
                {current?.label ?? value}
                <svg className="size-4 opacity-70" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
            </span>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value as T)}
                className="absolute inset-0 opacity-0 cursor-pointer"
                aria-label={label}
            >
                {options.map(o => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </label>
    )
}

/**
 * Mark-whole-series-watched button. TV-only. Confirms before firing
 * the bulk upsert (it's destructive in the sense that it stamps every
 * episode as finished, which the user might not be able to undo
 * cleanly later without per-episode deletion).
 */
function MarkSeriesWatchedButton({
    tmdbId,
    title,
    posterPath,
    backdropUrl,
    seasons,
}: {
    tmdbId: number
    title: string
    posterPath: string
    backdropUrl: string
    seasons: { season_number: number; episode_count: number }[]
}) {
    const { t } = useTranslation()
    const markSeries = useMarkSeriesWatched()
    const profileUid = useActiveProfileId()
    const [busy, setBusy] = React.useState(false)
    const [done, setDone] = React.useState<number | null>(null)

    if (!profileUid) return null

    const totalEpisodes = seasons.reduce((acc, s) => acc + (s.episode_count || 0), 0)
    if (totalEpisodes === 0) return null

    const onClick = async () => {
        const confirmed = window.confirm(
            t(
                "modal.mark_watched_confirm",
                "Marquer les {{n}} épisodes de « {{title}} » comme vus ?",
                { n: totalEpisodes, title },
            ),
        )
        if (!confirmed) return
        setBusy(true)
        setDone(null)
        try {
            const res = await markSeries({
                tmdbId,
                title,
                posterPath,
                backdropUrl,
                seasons: seasons
                    .filter(s => s.season_number > 0 && s.episode_count > 0)
                    .map(s => ({ season: s.season_number, episodes: s.episode_count })),
            })
            setDone(res?.marked ?? 0)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex flex-col gap-1">
            <button
                type="button"
                onClick={onClick}
                disabled={busy}
                className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-2 rounded-md",
                    "bg-white/10 hover:bg-white/15 text-white text-sm font-semibold",
                    "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                )}
            >
                <BiCheck className="size-5" />
                {busy
                    ? t("modal.mark_watched_busy", "Marquage…")
                    : t("modal.mark_watched", "Marquer toute la série vue")}
            </button>
            {done !== null && (
                <span className="text-[10px] text-emerald-300/80">
                    {t("modal.mark_watched_done", "✓ {{n}} épisodes marqués", { n: done })}
                </span>
            )}
        </div>
    )
}

/**
 * "Ma liste" toggle — Netflix's + / ✓ pill. Always rendered (even
 * without an active profile — clicking then routes to /profiles so the
 * user can create / pick one). Optimistic by design:
 * useProfileListActions mutates the React Query cache before the
 * network call so the icon flips instantly.
 */
function ListToggleButton({
    tmdbId,
    mediaType,
    title,
    posterPath,
}: {
    tmdbId: number
    mediaType: "movie" | "tv"
    title: string
    posterPath: string
}) {
    const { t } = useTranslation()
    const router = useRouter()
    const { closeDetail } = useNetflixDetailModal()
    const profileUid = useActiveProfileId()
    const statusMap = useActiveProfileListStatusMap()
    const { upsert, remove } = useProfileListActions()

    const inList = !!profileUid && statusMap.has(listEntryKey(mediaType, tmdbId))

    const onClick = () => {
        if (!profileUid) {
            // No profile yet — punt the user over to /profiles. They
            // can come back and click + once they've picked one.
            closeDetail()
            router.push("/profiles")
            return
        }
        if (inList) {
            void remove(tmdbId, mediaType)
        } else {
            void upsert({
                tmdbId,
                mediaType,
                status: "PLANNING",
                title,
                posterPath,
            })
        }
    }

    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={
                !profileUid
                    ? t("modal.list_requires_profile", "Sélectionner un profil pour ajouter à la liste")
                    : inList
                        ? t("modal.remove_from_list", "Retirer de ma liste")
                        : t("modal.add_to_list", "Ajouter à ma liste")
            }
            className={cn(
                "inline-flex items-center justify-center gap-2",
                "h-10 lg:h-12 px-4 lg:px-5 rounded-md",
                "bg-white/20 hover:bg-white/30 backdrop-blur-sm",
                "text-white text-sm lg:text-base font-semibold",
                "transition-colors",
                inList && "bg-brand-500/30 border border-brand-500/60",
            )}
        >
            {inList ? <BiCheck className="text-xl sm:text-2xl" /> : <BiPlus className="text-xl sm:text-2xl" />}
            <span className="hidden sm:inline">
                {inList ? t("modal.in_list", "Dans ma liste") : t("modal.my_list", "Ma liste")}
            </span>
        </button>
    )
}

function BodySkeleton() {
    return (
        <div className="space-y-6">
            <Skeleton className="w-full aspect-[16/8] rounded-none" />
            <div className="px-10 pb-10 space-y-3">
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-3/4" />
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Speculative TorBox prefetch
// ---------------------------------------------------------------------------

/** Session-scoped Set of infoHashes we've already prefetched. Avoids
 *  re-firing AddMagnet when the user re-opens the same detail modal. */
const __prefetchedHashes = new Set<string>()

/** useTorBoxPrefetch fires a single AddMagnet for the best non-cached
 *  release of `title` (movie) after a 5 s dwell on the detail modal.
 *  Idempotent within a session — re-opening the same modal does NOT
 *  re-trigger the prefetch.
 *
 *  Quiet when:
 *    - title is empty (e.g. caller hasn't loaded the TMDB data yet)
 *    - TorBox isn't configured (the backend silently no-ops anyway)
 *    - the top release is already cached (no need to nudge)
 *    - the top release has too few seeders (speedTier slow/very_slow —
 *      pre-adding it just wastes quota; TorBox can't peer-fetch fast)
 */
function useTorBoxPrefetch(title: string, year?: number) {
    const [armed, setArmed] = React.useState(false)

    // Dwell timer. Re-armed whenever title changes (new modal open).
    React.useEffect(() => {
        setArmed(false)
        if (!title) return
        const t = window.setTimeout(() => setArmed(true), 5_000)
        return () => window.clearTimeout(t)
    }, [title, year])

    // Only when armed do we fire the actual Prowlarr search. Reusing
    // useSearchMovie means the result is also warm in the cache when
    // the user clicks Lecture and /watch hits the same key.
    const { data: releases } = useSearchMovie(armed ? title : "", armed ? year : undefined)

    React.useEffect(() => {
        if (!armed || !releases || releases.length === 0) return
        // Already sorted by score desc — take the top.
        const best = releases[0]
        if (!best || best.cached) return
        if (best.speedTier === "slow" || best.speedTier === "very_slow") return
        const key = (best.infoHash || best.magnetUrl || best.downloadUrl || "").toLowerCase()
        if (!key || __prefetchedHashes.has(key)) return
        __prefetchedHashes.add(key)

        // Fire-and-forget. Errors are swallowed — worst case the user
        // pays the regular TorBox add cost at Play time.
        fetch("/api/v1/torbox/prefetch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                magnet: best.magnetUrl,
                downloadUrl: best.downloadUrl,
                infoHash: best.infoHash,
            }),
        }).catch(() => { /* silent */ })
    }, [armed, releases])
}
