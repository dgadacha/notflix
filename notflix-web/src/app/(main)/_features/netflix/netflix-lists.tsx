/**
 * /lists — two tabs:
 *   - "Ma liste"   : items the user explicitly added via the modal's
 *                    + button. Backed by ProfileListEntry rows.
 *   - "Historique" : every watched media (in-progress + finished),
 *                    most-recent first. Backed by ProfileWatchHistory.
 *
 * Both views render an action menu on each card (hover): jump to the
 * detail modal, remove from list / history. All mutations are
 * optimistic — see lib/profiles/profiles.ts.
 */
import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { useRouter } from "@/lib/navigation"
import {
    ProfileWatchEntry,
    useActiveProfileHistoryQuery,
    useActiveProfileId,
    useActiveProfileListQuery,
    useProfileHistoryActions,
    useProfileListActions,
    ProfileListEntry,
} from "@/lib/profiles/profiles"
import { tmdbImage } from "@/lib/tmdb"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiCheck, BiPlay, BiTrash, BiX } from "react-icons/bi"
import { LuArrowDownAZ, LuClock } from "react-icons/lu"

type TabKey = "list" | "history"

export function NetflixLists() {
    const { t } = useTranslation()
    const profileUid = useActiveProfileId()
    const [tab, setTab] = React.useState<TabKey>("list")

    if (!profileUid) {
        return (
            <div className="px-4 sm:px-6 lg:px-16 py-12 lg:py-20 space-y-6 max-w-3xl mx-auto text-center">
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                    {t("lists.title", "Mes listes")}
                </h1>
                <p className="text-[--muted]">
                    {t(
                        "lists.requires_profile",
                        "Sélectionnez un profil pour voir votre liste et votre historique.",
                    )}
                </p>
            </div>
        )
    }

    return (
        <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-8 space-y-6 lg:space-y-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                {t("lists.title", "Mes listes")}
            </h1>

            <div className="flex items-center gap-2">
                <TabPill
                    label={t("lists.tabs.my_list", "Ma liste")}
                    active={tab === "list"}
                    onClick={() => setTab("list")}
                />
                <TabPill
                    label={t("lists.tabs.history", "Historique")}
                    active={tab === "history"}
                    onClick={() => setTab("history")}
                />
            </div>

            {tab === "list" ? <MyListGrid /> : <HistoryGrid />}
        </div>
    )
}

function TabPill({
    label,
    active,
    onClick,
}: {
    label: string
    active: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "px-4 py-1.5 text-sm font-semibold rounded-full transition-colors",
                active
                    ? "bg-brand-500 text-white"
                    : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white",
            )}
        >
            {label}
        </button>
    )
}

// ---------------------------------------------------------------------------
// Ma liste
// ---------------------------------------------------------------------------

type ListSortMode = "recent" | "alphabetical"
type ListFilterMode = "all" | "movie" | "tv"

function MyListGrid() {
    const { t } = useTranslation()
    const { data: list, isLoading } = useActiveProfileListQuery()
    const { remove } = useProfileListActions()
    const { openDetail } = useNetflixDetailModal()

    const [sort, setSort] = React.useState<ListSortMode>("recent")
    const [filter, setFilter] = React.useState<ListFilterMode>("all")
    // Set of "<mediaType>-<tmdbId>" keys currently selected. Empty set
    // = selection mode off.
    const [selected, setSelected] = React.useState<Set<string>>(new Set())

    const entryKey = (e: ProfileListEntry) => `${e.mediaType}-${e.tmdbId}`

    const visible = React.useMemo(() => {
        let xs: ProfileListEntry[] = list
        if (filter !== "all") {
            xs = xs.filter(e => e.mediaType === filter)
        }
        if (sort === "alphabetical") {
            xs = [...xs].sort((a, b) => (a.title || "").localeCompare(b.title || ""))
        } else {
            xs = [...xs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        }
        return xs
    }, [list, sort, filter])

    const toggleSelect = (e: ProfileListEntry) => {
        setSelected(prev => {
            const next = new Set(prev)
            const k = entryKey(e)
            if (next.has(k)) next.delete(k)
            else next.add(k)
            return next
        })
    }
    const clearSelection = () => setSelected(new Set())
    const selectAllVisible = () => setSelected(new Set(visible.map(entryKey)))
    const deleteSelected = () => {
        // Fire all remove() calls — the mutation hook handles optimistic
        // updates so the UI shrinks as each succeeds.
        for (const e of visible) {
            if (selected.has(entryKey(e))) {
                remove(e.tmdbId, e.mediaType)
            }
        }
        setSelected(new Set())
    }

    const selectionMode = selected.size > 0

    if (isLoading) {
        return <ListSkeletonGrid />
    }

    if (list.length === 0) {
        return (
            <p className="text-center py-12 text-[--muted]">
                {t("lists.empty_list", "Aucun titre dans votre liste. Cliquez sur le + d'une fiche pour l'ajouter.")}
            </p>
        )
    }

    return (
        <div className="space-y-3">
            <ListToolbar
                sort={sort}
                onSortChange={setSort}
                filter={filter}
                onFilterChange={setFilter}
                count={list.length}
                visibleCount={visible.length}
            />
            {selectionMode && (
                <SelectionBar
                    count={selected.size}
                    onSelectAll={selectAllVisible}
                    onClear={clearSelection}
                    onDelete={deleteSelected}
                />
            )}
            {visible.length === 0 ? (
                <p className="text-center py-12 text-[--muted]">
                    {t("lists.empty_filter", "Aucun titre ne correspond à ce filtre.")}
                </p>
            ) : (
                <ResultGrid>
                    {visible.map(entry => {
                        const k = entryKey(entry)
                        const isSelected = selected.has(k)
                        return (
                            <ListCard
                                key={k}
                                entry={entry}
                                selectionMode={selectionMode}
                                isSelected={isSelected}
                                onOpen={() => {
                                    if (selectionMode) toggleSelect(entry)
                                    else openDetail(entry.tmdbId, entry.mediaType)
                                }}
                                onRemove={() => remove(entry.tmdbId, entry.mediaType)}
                                onToggleSelect={() => toggleSelect(entry)}
                            />
                        )
                    })}
                </ResultGrid>
            )}
        </div>
    )
}

function ListToolbar({
    sort,
    onSortChange,
    filter,
    onFilterChange,
    count,
    visibleCount,
}: {
    sort: ListSortMode
    onSortChange: (m: ListSortMode) => void
    filter: ListFilterMode
    onFilterChange: (m: ListFilterMode) => void
    count: number
    visibleCount: number
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Filter chips */}
            <div className="flex items-center gap-1">
                <FilterChip active={filter === "all"} onClick={() => onFilterChange("all")}>
                    {t("lists.filter_all", "Tout")}
                </FilterChip>
                <FilterChip active={filter === "movie"} onClick={() => onFilterChange("movie")}>
                    {t("lists.filter_movies", "Films")}
                </FilterChip>
                <FilterChip active={filter === "tv"} onClick={() => onFilterChange("tv")}>
                    {t("lists.filter_tv", "Séries")}
                </FilterChip>
            </div>
            <div className="flex-1 min-w-0" />
            {/* Sort toggle — two-option, so a pill switcher beats a dropdown */}
            <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-full p-0.5">
                <SortPill active={sort === "recent"} onClick={() => onSortChange("recent")}>
                    <LuClock className="size-3.5" />
                    {t("lists.sort_recent", "Récent")}
                </SortPill>
                <SortPill active={sort === "alphabetical"} onClick={() => onSortChange("alphabetical")}>
                    <LuArrowDownAZ className="size-3.5" />
                    {t("lists.sort_alphabetical", "A-Z")}
                </SortPill>
            </div>
            {/* Count */}
            <span className="text-[--muted] text-[11px] shrink-0">
                {visibleCount === count
                    ? t("lists.count", "{{n}} titres", { n: count })
                    : t("lists.count_filtered", "{{v}}/{{n}}", { v: visibleCount, n: count })}
            </span>
        </div>
    )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "px-2.5 py-1 rounded-full font-semibold transition-colors",
                active
                    ? "bg-white text-black"
                    : "bg-white/5 text-white/80 hover:bg-white/10",
            )}
        >
            {children}
        </button>
    )
}

function SortPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-semibold transition-colors",
                active
                    ? "bg-white text-black"
                    : "text-white/70 hover:text-white",
            )}
        >
            {children}
        </button>
    )
}

function SelectionBar({
    count,
    onSelectAll,
    onClear,
    onDelete,
}: {
    count: number
    onSelectAll: () => void
    onClear: () => void
    onDelete: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className={cn(
            "flex flex-wrap items-center gap-2 px-3 py-2 rounded-md",
            "bg-brand-500/10 border border-brand-500/30 text-sm",
        )}>
            <span className="text-white font-semibold">
                {t("lists.selection_count", "{{n}} sélectionné(s)", { n: count })}
            </span>
            <div className="flex-1 min-w-0" />
            <button
                type="button"
                onClick={onSelectAll}
                className="px-2.5 py-1 rounded-md text-xs font-semibold bg-white/10 hover:bg-white/15 text-white"
            >
                {t("lists.select_all", "Tout sélectionner")}
            </button>
            <button
                type="button"
                onClick={onDelete}
                className="px-2.5 py-1 rounded-md text-xs font-bold bg-red-500/80 hover:bg-red-500 text-white inline-flex items-center gap-1"
            >
                <BiTrash className="size-4" />
                {t("lists.delete_selected", "Supprimer")}
            </button>
            <button
                type="button"
                onClick={onClear}
                className="px-2 py-1 rounded-md text-xs font-semibold text-white/70 hover:text-white inline-flex items-center gap-1"
                aria-label={t("common.cancel", "Annuler")}
            >
                <BiX className="size-4" />
            </button>
        </div>
    )
}

function ListCard({
    entry,
    onOpen,
    onRemove,
    selectionMode,
    isSelected,
    onToggleSelect,
}: {
    entry: ProfileListEntry
    onOpen: () => void
    onRemove: () => void
    selectionMode: boolean
    isSelected: boolean
    onToggleSelect: () => void
}) {
    const { t } = useTranslation()
    const img = tmdbImage("w500", entry.posterPath) || ""
    return (
        <div
            className={cn(
                "group relative aspect-video rounded-md overflow-hidden bg-gray-900",
                "transition-[transform,box-shadow] duration-200",
                "hover:scale-[1.03] hover:z-[2] hover:shadow-2xl transform-gpu origin-center",
                isSelected ? "ring-2 ring-brand-500" : "ring-0 ring-brand-500 hover:ring-2",
            )}
        >
            <button
                type="button"
                onClick={onOpen}
                className="absolute inset-0 cursor-pointer"
                aria-label={entry.title}
            >
                {img && (
                    <img
                        src={img}
                        alt={entry.title}
                        loading="lazy"
                        className={cn(
                            "w-full h-full object-cover object-center",
                            isSelected && "opacity-70",
                        )}
                    />
                )}
            </button>
            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent pointer-events-none">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {entry.title}
                </p>
            </div>
            {/* Selection checkbox — always visible in selection mode,
                appears on hover otherwise so the user can toggle on
                without leaving normal browsing. */}
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation()
                    onToggleSelect()
                }}
                aria-label={t("lists.select", "Sélectionner")}
                className={cn(
                    "absolute top-2 left-2 size-6 rounded-md border-2 transition-all",
                    "flex items-center justify-center",
                    isSelected
                        ? "bg-brand-500 border-brand-500 text-white"
                        : "bg-black/60 border-white/60 text-transparent hover:border-white",
                    selectionMode
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                )}
            >
                <BiCheck className="size-4" />
            </button>
            {/* Single-item remove — hidden in selection mode to avoid
                conflicting affordances. */}
            {!selectionMode && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation()
                        onRemove()
                    }}
                    aria-label={t("lists.remove", "Retirer")}
                    className={cn(
                        "absolute top-2 right-2 p-2 rounded-full",
                        "bg-black/70 text-white hover:bg-red-500/80 hover:text-white",
                        "opacity-0 group-hover:opacity-100 transition-opacity",
                    )}
                >
                    <BiTrash className="size-4" />
                </button>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------

function HistoryGrid() {
    const { t } = useTranslation()
    const { data: history, isLoading } = useActiveProfileHistoryQuery()
    const router = useRouter()
    const { deleteByMedia } = useProfileHistoryActions()
    const { openDetail } = useNetflixDetailModal()

    const sorted = React.useMemo(
        () =>
            [...history].sort(
                (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            ),
        [history],
    )

    if (isLoading) {
        return <ListSkeletonGrid />
    }

    if (sorted.length === 0) {
        return (
            <p className="text-center py-12 text-[--muted]">
                {t("lists.empty_history", "Aucun titre dans l'historique.")}
            </p>
        )
    }

    const onResume = (e: ProfileWatchEntry) => {
        const params = new URLSearchParams({
            id: String(e.tmdbId),
            type: e.mediaType,
        })
        if (e.mediaType === "tv" && e.season > 0) {
            params.set("season", String(e.season))
            params.set("episode", String(e.episode || 1))
        }
        if (e.currentTime > 0) params.set("t", String(Math.floor(e.currentTime)))
        if (e.releaseSource) params.set("releaseSource", e.releaseSource)
        if (e.releaseName) params.set("releaseName", e.releaseName)
        if (e.releaseInfoHash) params.set("releaseHash", e.releaseInfoHash)
        router.push(`/watch?${params.toString()}`)
    }

    return (
        <ResultGrid>
            {sorted.map(entry => (
                <HistoryCard
                    key={`${entry.mediaType}-${entry.tmdbId}-${entry.season}-${entry.episode}`}
                    entry={entry}
                    onOpenDetail={() => openDetail(entry.tmdbId, entry.mediaType)}
                    onResume={() => onResume(entry)}
                    onRemove={() => deleteByMedia(entry.tmdbId, entry.mediaType)}
                />
            ))}
        </ResultGrid>
    )
}

function HistoryCard({
    entry,
    onOpenDetail,
    onResume,
    onRemove,
}: {
    entry: ProfileWatchEntry
    onOpenDetail: () => void
    onResume: () => void
    onRemove: () => void
}) {
    const { t } = useTranslation()
    const img =
        tmdbImage("w780", entry.backdropUrl) ||
        tmdbImage("w500", entry.posterPath) ||
        ""
    const progress = entry.duration > 0 ? entry.currentTime / entry.duration : 0
    const finished = progress >= 0.99 || entry.duration - entry.currentTime < 60

    return (
        <div
            className={cn(
                "group relative aspect-video rounded-md overflow-hidden bg-gray-900",
                "ring-0 ring-brand-500 hover:ring-2 transition-[transform,box-shadow] duration-200",
                "hover:scale-[1.03] hover:z-[2] hover:shadow-2xl transform-gpu origin-center",
            )}
        >
            <button
                type="button"
                onClick={onResume}
                className="absolute inset-0 cursor-pointer text-left"
                aria-label={entry.title}
            >
                {img && (
                    <img
                        src={img}
                        alt={entry.title}
                        loading="lazy"
                        className="w-full h-full object-cover object-center"
                    />
                )}
            </button>

            {/* Progress bar */}
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                <div
                    className="h-full bg-brand-500"
                    style={{ width: `${Math.min(100, Math.max(2, progress * 100))}%` }}
                />
            </div>

            <div className="absolute inset-x-0 bottom-1 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent pointer-events-none">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {entry.title}
                </p>
                <p className="text-gray-300 text-xs mt-0.5 line-clamp-1">
                    {entry.mediaType === "tv" && entry.season > 0
                        ? `S${entry.season}E${entry.episode || 1} · `
                        : ""}
                    {finished
                        ? t("lists.finished", "Terminé")
                        : t("lists.in_progress", "{{p}}%", { p: Math.round(progress * 100) })}
                </p>
            </div>

            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 flex items-center justify-center transition-colors pointer-events-none">
                <BiPlay className="size-12 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>

            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation()
                        onOpenDetail()
                    }}
                    aria-label={t("lists.open_detail", "Voir la fiche")}
                    className="p-2 rounded-full bg-black/70 text-white hover:bg-black/90"
                >
                    <BiPlay className="size-4 rotate-90 opacity-0 hidden" />
                    {/* Use a "i" letter for "info" via plain text — keeps
                        the dependency surface flat. */}
                    <span className="block text-xs font-bold">i</span>
                </button>
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation()
                        onRemove()
                    }}
                    aria-label={t("lists.remove_from_history", "Retirer de l'historique")}
                    className="p-2 rounded-full bg-black/70 text-white hover:bg-red-500/80"
                >
                    <BiTrash className="size-4" />
                </button>
            </div>
        </div>
    )
}

function ResultGrid({ children }: { children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-4 gap-y-6 py-2">
            {children}
        </div>
    )
}

/** Shimmer placeholder used by both tabs while the network call resolves. */
function ListSkeletonGrid() {
    return (
        <ResultGrid>
            {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="w-full aspect-video rounded-md" />
            ))}
        </ResultGrid>
    )
}
