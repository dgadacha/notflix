/**
 * "Historique" tab content for /lists.
 *
 * Reads the active profile's per-episode watch history and groups it by
 * mediaId. Each group renders as one row with the cover, the most-recent
 * episode/position, an expand toggle revealing every watched episode and
 * actions to delete one episode or the entire series.
 */
import { useGetAnimeCollection } from "@/api/hooks/anilist.hooks"
import { useGetAnimeEntry } from "@/api/hooks/anime_entries.hooks"
import { useDeleteAnilistListEntry } from "@/api/hooks/anilist.hooks"
import {
    ProfileWatchEntry,
    useActiveProfileHistory,
    useActiveProfileId,
    useProfileHistoryActions,
} from "@/lib/profiles/profiles"
import { Button } from "@/components/ui/button"
import { SeaImage } from "@/components/shared/sea-image"
import { cn } from "@/components/ui/core/styling"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiChevronDown, BiChevronUp, BiPlay, BiTrash } from "react-icons/bi"

type Group = {
    mediaId: number
    latest: ProfileWatchEntry
    episodes: ProfileWatchEntry[]  // sorted by episodeNumber asc
}

type DateBucket = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older"

/** Bucket label used by the section headers in the History tab. */
function bucketOf(updatedAtIso: string): DateBucket {
    const updated = new Date(updatedAtIso)
    const now = new Date()
    const dayMs = 24 * 60 * 60 * 1000

    // Compare by calendar day, not by elapsed ms — "watched at 23h yesterday"
    // shouldn't be lumped with "watched 22h ago" if those straddle midnight.
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const updatedDay = new Date(updated.getFullYear(), updated.getMonth(), updated.getDate()).getTime()
    const diffDays = Math.round((startOfToday - updatedDay) / dayMs)

    if (diffDays <= 0) return "today"
    if (diffDays === 1) return "yesterday"
    if (diffDays <= 7) return "thisWeek"
    if (diffDays <= 30) return "thisMonth"
    return "older"
}

const BUCKET_ORDER: DateBucket[] = ["today", "yesterday", "thisWeek", "thisMonth", "older"]
const BUCKET_I18N: Record<DateBucket, string> = {
    today: "history.bucket.today",
    yesterday: "history.bucket.yesterday",
    thisWeek: "history.bucket.this_week",
    thisMonth: "history.bucket.this_month",
    older: "history.bucket.older",
}

export function NetflixHistoryGrid() {
    const { t } = useTranslation()
    const profileId = useActiveProfileId()
    const history = useActiveProfileHistory()
    const { clearAll } = useProfileHistoryActions()

    // Group by mediaId. Within each group, sort episodes by number; the "row"
    // shows the most recently *updated* episode (best resume target).
    const groups = React.useMemo<Group[]>(() => {
        const byMedia = new Map<number, ProfileWatchEntry[]>()
        for (const e of history) {
            if (!byMedia.has(e.mediaId)) byMedia.set(e.mediaId, [])
            byMedia.get(e.mediaId)!.push(e)
        }
        const out: Group[] = []
        for (const [mediaId, entries] of byMedia) {
            const sortedByEp = [...entries].sort((a, b) => a.episodeNumber - b.episodeNumber)
            const latest = [...entries].sort((a, b) =>
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            )[0]
            out.push({ mediaId, latest, episodes: sortedByEp })
        }
        return out.sort((a, b) =>
            new Date(b.latest.updatedAt).getTime() - new Date(a.latest.updatedAt).getTime(),
        )
    }, [history])

    // Second pass: bucket each group by when it was last touched.
    const buckets = React.useMemo<Record<DateBucket, Group[]>>(() => {
        const out: Record<DateBucket, Group[]> = {
            today: [], yesterday: [], thisWeek: [], thisMonth: [], older: [],
        }
        for (const g of groups) {
            out[bucketOf(g.latest.updatedAt)].push(g)
        }
        return out
    }, [groups])

    if (!profileId) {
        return (
            <div className="text-center py-20 text-[--muted]">
                {t("history.no_profile")}
            </div>
        )
    }

    if (groups.length === 0) {
        return (
            <div className="text-center py-20 text-[--muted]">
                {t("history.empty")}
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-end">
                <Button
                    intent="white-outline"
                    size="sm"
                    rounded
                    leftIcon={<BiTrash />}
                    onClick={() => {
                        if (confirm(t("history.clear_confirm"))) clearAll()
                    }}
                >
                    {t("history.clear_all")}
                </Button>
            </div>

            {/* Sections grouped by recency — "Aujourd'hui", "Hier", "Cette
                semaine", "Ce mois-ci", "Plus ancien". Empty buckets are
                silently skipped. */}
            <div className="space-y-6">
                {BUCKET_ORDER.map(bucket => {
                    const items = buckets[bucket]
                    if (items.length === 0) return null
                    return (
                        <section key={bucket} className="space-y-2">
                            <h3 className="text-sm font-semibold uppercase tracking-wider text-[--muted]">
                                {t(BUCKET_I18N[bucket])}
                            </h3>
                            <div className="rounded-lg border border-white/10 divide-y divide-white/10 overflow-hidden bg-white/[0.02]">
                                {items.map(g => <HistoryRow key={g.mediaId} group={g} />)}
                            </div>
                        </section>
                    )
                })}
            </div>
        </div>
    )
}

function HistoryRow({ group }: { group: Group }) {
    const { t } = useTranslation()
    const { deleteSeries, deleteEpisode } = useProfileHistoryActions()
    const [expanded, setExpanded] = React.useState(false)

    // Resolve cover + title — same trick as Continue Watching: try the cached
    // AniList collection first, fall back to a per-entry fetch.
    const { data: collection } = useGetAnimeCollection()
    const fromCollection = React.useMemo(() => {
        if (!collection) return null
        for (const list of collection.MediaListCollection?.lists ?? []) {
            for (const entry of list?.entries ?? []) {
                if (entry?.media?.id === group.mediaId) return entry.media
            }
        }
        return null
    }, [collection, group.mediaId])
    const { data: entry } = useGetAnimeEntry(fromCollection ? null : group.mediaId)
    const media = fromCollection ?? entry?.media ?? null

    const cover = media?.coverImage?.large || media?.coverImage?.medium || ""
    const title = media?.title?.userPreferred || `#${group.mediaId}`

    // Optional: also drop from AniList list when the user deletes the whole
    // series — matches the user's request "ce qui les supprimera des suivies".
    const { mutate: anilistDelete } = useDeleteAnilistListEntry(group.mediaId, "anime", () => { /* cache invalidated by hook */ })

    const onDeleteSeries = async () => {
        const alsoUnlist = confirm(t("history.delete_series_with_unlist_confirm"))
        await deleteSeries(group.mediaId)
        if (alsoUnlist) anilistDelete({ mediaId: group.mediaId, type: "anime" })
    }

    const onDeleteEpisode = (episodeNumber: number) => {
        if (!confirm(t("history.delete_episode_confirm"))) return
        void deleteEpisode(group.mediaId, episodeNumber)
    }

    const latestProgress = group.latest.duration > 0
        ? Math.floor((group.latest.currentTime / group.latest.duration) * 100)
        : 0

    return (
        <div className="bg-transparent">
            {/* Header row */}
            <div className="flex items-center gap-4 p-4 hover:bg-white/[0.04] transition-colors">
                <a
                    href={`/watch?id=${group.mediaId}&episode=${group.latest.episodeNumber}&t=${Math.floor(group.latest.currentTime)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("home.hero.play")}
                    className="shrink-0"
                >
                    <div className="relative size-16 lg:size-20 rounded-md overflow-hidden bg-gray-900">
                        {cover && <SeaImage src={cover} alt={title} fill className="object-cover" />}
                        <div className="absolute inset-0 bg-black/30 opacity-0 hover:opacity-100 transition flex items-center justify-center">
                            <BiPlay className="text-3xl text-white" />
                        </div>
                    </div>
                </a>

                <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold line-clamp-1">{title}</p>
                    <p className="text-xs lg:text-sm text-[--muted] mt-0.5">
                        {t("entry.episode_short")} {group.latest.episodeNumber}
                        {" · "}
                        {latestProgress}%
                        {" · "}
                        {group.episodes.length} {t("history.episodes_count")}
                    </p>
                </div>

                <button
                    type="button"
                    onClick={() => setExpanded(e => !e)}
                    className="shrink-0 p-2 rounded-md text-[--muted] hover:text-white hover:bg-white/10"
                    aria-label={expanded ? t("history.collapse") : t("history.expand")}
                >
                    {expanded ? <BiChevronUp className="text-xl" /> : <BiChevronDown className="text-xl" />}
                </button>

                <Button
                    intent="white-subtle"
                    size="sm"
                    rounded
                    leftIcon={<BiTrash />}
                    onClick={onDeleteSeries}
                    className="shrink-0"
                >
                    {t("history.delete_series")}
                </Button>
            </div>

            {/* Expanded episodes */}
            {expanded && (
                <div className="bg-black/40 px-4 pb-4 pt-1 space-y-1">
                    {group.episodes.map(ep => (
                        <EpisodeRow
                            key={ep.episodeNumber}
                            entry={ep}
                            mediaId={group.mediaId}
                            onDelete={() => onDeleteEpisode(ep.episodeNumber)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

function EpisodeRow({
    entry,
    mediaId,
    onDelete,
}: {
    entry: ProfileWatchEntry
    mediaId: number
    onDelete: () => void
}) {
    const { t } = useTranslation()
    const progress = entry.duration > 0 ? entry.currentTime / entry.duration : 0
    return (
        <div className="flex items-center gap-3 py-2">
            <a
                href={`/watch?id=${mediaId}&episode=${entry.episodeNumber}&t=${Math.floor(entry.currentTime)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-white/90 hover:text-white shrink-0 w-16"
            >
                {t("entry.episode_short")} {entry.episodeNumber}
            </a>

            <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                <div
                    className={cn("h-full bg-brand-500")}
                    style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
                />
            </div>

            <span className="text-xs text-[--muted] tabular-nums w-16 text-right">
                {Math.floor(progress * 100)}%
            </span>

            <button
                type="button"
                onClick={onDelete}
                aria-label={t("history.delete_episode")}
                className="p-1 text-[--muted] hover:text-red-400"
            >
                <BiTrash className="text-base" />
            </button>
        </div>
    )
}
