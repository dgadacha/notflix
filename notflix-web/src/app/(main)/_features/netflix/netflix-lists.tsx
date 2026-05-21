import { AL_BaseAnime, AL_MediaListStatus } from "@/api/generated/types"
import { useGetAnimeCollection } from "@/api/hooks/anilist.hooks"
import { NetflixCard } from "@/app/(main)/_features/netflix/netflix-card"
import { NetflixHistoryGrid } from "@/app/(main)/_features/netflix/netflix-history-grid"
import { NetflixListCardMenu } from "@/app/(main)/_features/netflix/netflix-list-card-menu"
import { useActiveProfileId, useActiveProfileList } from "@/lib/profiles/profiles"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import { TextInput } from "@/components/ui/text-input"
import { useDebounce } from "@/hooks/use-debounce"
import React from "react"
import { useTranslation } from "react-i18next"
import { FiSearch } from "react-icons/fi"

type ListKey = "all" | "current" | "planning" | "completed" | "paused" | "dropped" | "history"

const STATUS_BY_KEY: Record<Exclude<ListKey, "all" | "history">, AL_MediaListStatus> = {
    current: "CURRENT",
    planning: "PLANNING",
    completed: "COMPLETED",
    paused: "PAUSED",
    dropped: "DROPPED",
}

type Entry = { media: AL_BaseAnime; status: AL_MediaListStatus | null }

export function NetflixLists() {
    const { t } = useTranslation()
    const { data, isLoading } = useGetAnimeCollection()

    const [active, setActive] = React.useState<ListKey>("current")
    const [searchInput, setSearchInput] = React.useState("")
    const search = useDebounce(searchInput.trim().toLowerCase(), 250)

    // When a profile is active, "Mes listes" reflects ONLY what that profile
    // has added (notflix_profile_list_entries). When no profile is active, fall
    // back to the global AniList collection — legacy single-user mode.
    const activeProfileId = useActiveProfileId()
    const profileList = useActiveProfileList()

    // Index the AniList collection by mediaId so we can resolve each profile
    // entry's media payload (cover, title, etc.) without re-walking the lists.
    const mediaById = React.useMemo(() => {
        const m = new Map<number, AL_BaseAnime>()
        for (const list of data?.MediaListCollection?.lists ?? []) {
            for (const entry of list?.entries ?? []) {
                if (entry?.media?.id != null) m.set(entry.media.id, entry.media as AL_BaseAnime)
            }
        }
        return m
    }, [data])

    /** Flat list of entries — profile-scoped if a profile is active, global otherwise. */
    const allEntries = React.useMemo<Entry[]>(() => {
        const wanted = active === "all" || active === "history"
            ? null
            : STATUS_BY_KEY[active]

        if (activeProfileId) {
            // Profile mode — entries from the notflix list, status from notflix,
            // media payload from the AniList cache (already loaded for the
            // shared account).
            const out: Entry[] = []
            for (const e of profileList) {
                if (wanted && e.status !== wanted) continue
                const media = mediaById.get(e.mediaId)
                if (!media) continue  // not yet in the AniList cache; skip silently
                out.push({ media, status: e.status as AL_MediaListStatus })
            }
            return out
        }

        // Single-user mode — same as before.
        const lists = data?.MediaListCollection?.lists ?? []
        const out: Entry[] = []
        for (const list of lists) {
            if (!list) continue
            if (wanted && list.status !== wanted) continue
            for (const entry of list.entries ?? []) {
                if (!entry?.media) continue
                out.push({
                    media: entry.media as AL_BaseAnime,
                    status: (list.status ?? null) as AL_MediaListStatus | null,
                })
            }
        }
        return out
    }, [data, active, activeProfileId, profileList, mediaById])

    // Genre filter — single-select chip row above the grid. "Tous" = no filter.
    // The available chips are derived from what's actually in this tab's
    // entries, so we never show a chip that would render zero results.
    const [activeGenre, setActiveGenre] = React.useState<string | null>(null)
    const availableGenres = React.useMemo<string[]>(() => {
        const counts = new Map<string, number>()
        for (const { media } of allEntries) {
            for (const g of media.genres ?? []) {
                if (!g) continue
                counts.set(g, (counts.get(g) ?? 0) + 1)
            }
        }
        // Sort by frequency desc so the most-represented genres come first.
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([g]) => g)
    }, [allEntries])

    // Reset the genre filter when switching tabs — otherwise sticking on
    // "Shōnen" on the Completed tab leaks across into Currently watching.
    React.useEffect(() => {
        setActiveGenre(null)
    }, [active])

    const filtered = React.useMemo<Entry[]>(() => {
        let out = allEntries
        if (activeGenre) {
            out = out.filter(({ media }) => (media.genres ?? []).includes(activeGenre))
        }
        if (search) {
            out = out.filter(({ media }) => {
                const titles = [
                    media.title?.userPreferred,
                    media.title?.romaji,
                    media.title?.english,
                    media.title?.native,
                ].filter(Boolean) as string[]
                return titles.some(t => t.toLowerCase().includes(search))
            })
        }
        return out
    }, [allEntries, search, activeGenre])

    const tabs: { key: ListKey; label: string }[] = [
        { key: "current", label: t("lists.tabs.current") },
        { key: "planning", label: t("lists.tabs.planning") },
        { key: "completed", label: t("lists.tabs.completed") },
        { key: "paused", label: t("lists.tabs.paused") },
        { key: "dropped", label: t("lists.tabs.dropped") },
        { key: "all", label: t("lists.tabs.all") },
        { key: "history", label: t("lists.tabs.history") },
    ]

    const showSearch = active !== "history"

    return (
        <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-8 space-y-6 lg:space-y-8">
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                    {t("lists.title")}
                </h1>

                {showSearch && (
                    <div className="lg:w-80">
                        <TextInput
                            placeholder={t("lists.search_placeholder")}
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            leftIcon={<FiSearch />}
                            className="bg-white/5 border-white/10 !text-white placeholder:text-[--muted] rounded-md"
                        />
                    </div>
                )}
            </div>

            {/* Pill tabs */}
            <div className="flex flex-wrap items-center gap-2">
                {tabs.map(tab => {
                    const isActive = active === tab.key
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setActive(tab.key)}
                            className={cn(
                                "px-4 py-1.5 text-sm font-semibold rounded-full transition-colors",
                                isActive
                                    ? "bg-brand-500 text-white"
                                    : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white",
                            )}
                        >
                            {tab.label}
                        </button>
                    )
                })}
            </div>

            {/* Genre chip row — hidden on History (history has its own filter
                surface) and on tabs that have no entries (nothing to filter). */}
            {active !== "history" && availableGenres.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-4 sm:-mx-6 lg:-mx-16 px-4 sm:px-6 lg:px-16 pb-1">
                    <button
                        type="button"
                        onClick={() => setActiveGenre(null)}
                        className={cn(
                            "shrink-0 px-3 py-1 text-xs font-semibold rounded-full transition-colors whitespace-nowrap",
                            activeGenre === null
                                ? "bg-white text-black"
                                : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white",
                        )}
                    >
                        {t("lists.tabs.all")}
                    </button>
                    {availableGenres.map(genre => (
                        <button
                            key={genre}
                            type="button"
                            onClick={() => setActiveGenre(genre === activeGenre ? null : genre)}
                            className={cn(
                                "shrink-0 px-3 py-1 text-xs font-semibold rounded-full transition-colors whitespace-nowrap",
                                activeGenre === genre
                                    ? "bg-white text-black"
                                    : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white",
                            )}
                        >
                            {genre}
                        </button>
                    ))}
                </div>
            )}

            {/* History tab has its own renderer (per-anime grouping + episode rows). */}
            {active === "history" ? (
                <NetflixHistoryGrid />
            ) : isLoading ? (
                <ResultGrid>
                    {Array.from({ length: 12 }).map((_, i) => (
                        <Skeleton key={i} className="w-full aspect-video rounded-md" />
                    ))}
                </ResultGrid>
            ) : filtered.length === 0 ? (
                <div className="text-center py-20 text-[--muted]">
                    {search ? t("lists.no_match") : t("lists.empty")}
                </div>
            ) : (
                <ResultGrid>
                    {filtered.map(({ media, status }) => (
                        <ListEntryCard key={media.id} media={media} status={status} />
                    ))}
                </ResultGrid>
            )}
        </div>
    )
}

/** Single grid card with the action menu pinned top-right (revealed on hover). */
function ListEntryCard({
    media,
    status,
}: {
    media: AL_BaseAnime
    status: AL_MediaListStatus | null
}) {
    return (
        <div className="relative group">
            <NetflixCard media={media} variant="grid" />
            <NetflixListCardMenu mediaId={media.id} currentStatus={status} />
        </div>
    )
}

/** Grid with vertical breathing room so card hover-scale doesn't crash into rows above/below. */
function ResultGrid({ children }: { children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-4 gap-y-6 py-2">
            {children}
        </div>
    )
}
