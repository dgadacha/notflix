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
import { useRouter } from "@/lib/navigation"
import {
    ProfileWatchEntry,
    useActiveProfileHistory,
    useActiveProfileId,
    useActiveProfileList,
    useProfileHistoryActions,
    useProfileListActions,
    ProfileListEntry,
} from "@/lib/profiles/profiles"
import { tmdbImage } from "@/lib/tmdb"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiPlay, BiTrash } from "react-icons/bi"

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

function MyListGrid() {
    const { t } = useTranslation()
    const list = useActiveProfileList()
    const { remove } = useProfileListActions()
    const { openDetail } = useNetflixDetailModal()

    if (list.length === 0) {
        return (
            <p className="text-center py-12 text-[--muted]">
                {t("lists.empty_list", "Aucun titre dans votre liste. Cliquez sur le + d'une fiche pour l'ajouter.")}
            </p>
        )
    }

    return (
        <ResultGrid>
            {list.map(entry => (
                <ListCard
                    key={`${entry.mediaType}-${entry.tmdbId}`}
                    entry={entry}
                    onOpen={() => openDetail(entry.tmdbId, entry.mediaType)}
                    onRemove={() => remove(entry.tmdbId, entry.mediaType)}
                />
            ))}
        </ResultGrid>
    )
}

function ListCard({
    entry,
    onOpen,
    onRemove,
}: {
    entry: ProfileListEntry
    onOpen: () => void
    onRemove: () => void
}) {
    const { t } = useTranslation()
    const img = tmdbImage("w500", entry.posterPath) || ""
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
                onClick={onOpen}
                className="absolute inset-0 cursor-pointer"
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
            <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent pointer-events-none">
                <p className="text-white font-semibold text-sm lg:text-base line-clamp-1 drop-shadow-md">
                    {entry.title}
                </p>
            </div>
            {/* Remove action — visible on hover. Stops propagation so the
                trash click doesn't also open the modal. */}
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
        </div>
    )
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------

function HistoryGrid() {
    const { t } = useTranslation()
    const history = useActiveProfileHistory()
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
