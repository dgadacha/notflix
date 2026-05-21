/**
 * Hover-revealed menu that lets the user move an anime between AniList lists
 * (Currently watching / Planning / Completed / Paused / Dropped) or remove it
 * entirely. Pinned to the top-right of the card on /lists.
 *
 * Click traps `stopPropagation` so the underlying card's modal doesn't open.
 */
import { AL_MediaListStatus } from "@/api/generated/types"
import { useDeleteAnilistListEntry, useEditAnilistListEntry } from "@/api/hooks/anilist.hooks"
import { useActiveProfileId, useProfileListActions, ProfileListEntry } from "@/lib/profiles/profiles"
import { cn } from "@/components/ui/core/styling"
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiCheck, BiDotsVerticalRounded, BiTrash } from "react-icons/bi"

type Props = {
    mediaId: number
    currentStatus?: AL_MediaListStatus | null
    /** Show the icon always (true) vs only on parent group hover (false). */
    alwaysVisible?: boolean
    className?: string
}

const STATUS_ORDER: AL_MediaListStatus[] = ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED"]

const STATUS_I18N: Record<AL_MediaListStatus, string> = {
    CURRENT: "lists.tabs.current",
    PLANNING: "lists.tabs.planning",
    COMPLETED: "lists.tabs.completed",
    PAUSED: "lists.tabs.paused",
    DROPPED: "lists.tabs.dropped",
    REPEATING: "lists.tabs.current",  // bucket repeating with current for the picker
}

export function NetflixListCardMenu({ mediaId, currentStatus, alwaysVisible, className }: Props) {
    const { t } = useTranslation()
    const { mutate: edit, isPending: editing } = useEditAnilistListEntry(mediaId, "anime")
    const { mutate: remove, isPending: removing } = useDeleteAnilistListEntry(mediaId, "anime", () => { /* refetched via cache invalidation */ })

    const activeProfileId = useActiveProfileId()
    const { upsert: profileUpsert, remove: profileRemove } = useProfileListActions()

    const stop = (e: React.SyntheticEvent) => {
        e.preventDefault()
        e.stopPropagation()
    }

    const moveTo = (status: AL_MediaListStatus) => {
        edit({ mediaId, status, type: "anime" })
        if (activeProfileId) {
            void profileUpsert(mediaId, status as ProfileListEntry["status"])
        }
    }

    const onDelete = () => {
        if (!confirm(t("lists.actions.delete_confirm"))) return
        if (activeProfileId) {
            // Profile-only delete — see comment in NetflixListPickerButton.
            void profileRemove(mediaId)
        } else {
            remove({ mediaId, type: "anime" })
        }
    }

    const busy = editing || removing

    return (
        <div
            className={cn(
                "absolute top-2 right-2 z-[3]",
                alwaysVisible
                    ? "opacity-100"
                    // On touch devices (no real hover), the hover-only opacity-100
                    // never triggers and the menu becomes unreachable. Force it
                    // visible whenever the platform reports no hover capability.
                    : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
                "transition-opacity duration-150",
                className,
            )}
            onClick={stop}
            onMouseDown={stop}
        >
            <DropdownMenu
                trigger={
                    <button
                        type="button"
                        aria-label={t("lists.actions.menu")}
                        disabled={busy}
                        className={cn(
                            "size-8 rounded-full flex items-center justify-center",
                            "bg-black/70 backdrop-blur-sm text-white shadow-md",
                            "hover:bg-black/90 active:scale-95 transition",
                            busy && "opacity-50 cursor-wait",
                        )}
                    >
                        <BiDotsVerticalRounded className="text-xl" />
                    </button>
                }
            >
                <div className="px-2 py-1 text-xs uppercase tracking-wider text-[--muted]">
                    {t("lists.actions.move_to")}
                </div>
                {STATUS_ORDER.map(status => {
                    const isActive = currentStatus === status
                    return (
                        <DropdownMenuItem
                            key={status}
                            onClick={(e) => {
                                stop(e)
                                if (!isActive) moveTo(status)
                            }}
                        >
                            {isActive
                                ? <BiCheck className="text-brand-500" />
                                : <span className="size-4" aria-hidden />}
                            {t(STATUS_I18N[status])}
                        </DropdownMenuItem>
                    )
                })}

                <DropdownMenuSeparator />

                <DropdownMenuItem onClick={(e) => { stop(e); onDelete() }}>
                    <BiTrash className="text-red-400" />
                    {t("lists.actions.delete")}
                </DropdownMenuItem>
            </DropdownMenu>
        </div>
    )
}
