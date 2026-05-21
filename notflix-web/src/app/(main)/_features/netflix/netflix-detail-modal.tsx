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
    useAudioPref,
    useQualityPref,
} from "@/lib/preferences"
import {
    listEntryKey,
    useActiveProfileId,
    useActiveProfileListStatusMap,
    useProfileListActions,
} from "@/lib/profiles/profiles"
import {
    mediaTypeOf,
    TMDBEpisode,
    titleOf,
    tmdbImage,
    useTMDBDetail,
    useTMDBSeason,
    yearOf,
} from "@/lib/tmdb"
import { atom, useAtom, useSetAtom } from "jotai"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiCheck, BiPlay, BiPlus, BiX } from "react-icons/bi"

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

    React.useEffect(() => {
        if (target.type !== "tv") return
        if (selectedSeason != null) return
        if (seasons.length === 0) return
        setSelectedSeason(seasons[0].season_number)
    }, [target.type, seasons, selectedSeason])

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
    const buildWatchUrl = (season?: number, episode?: number) => {
        const params = new URLSearchParams({ id: String(data.id), type })
        if (quality !== "auto") params.set("quality", quality)
        if (audio !== "auto") params.set("audio", audio)
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

    return (
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
                />
            )}
        </div>
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
}: {
    tvId: number
    seasons: SeasonSummary[]
    selectedSeason: number
    onChangeSeason: (n: number) => void
    onPickEpisode: (season: number, episode: number) => void
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
                    {episodes.map(ep => (
                        <li key={ep.id}>
                            <EpisodeRow
                                episode={ep}
                                onClick={() => onPickEpisode(selectedSeason, ep.episode_number)}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

function EpisodeRow({ episode, onClick }: { episode: TMDBEpisode; onClick: () => void }) {
    const thumb = tmdbImage("w300", episode.still_path)
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
