/**
 * Prominent list-add / list-change button for the detail modal hero.
 *
 * - Not in any list yet  →  "+ Ajouter à mes listes" → click to add (defaults
 *                            to PLANNING) and reveals the change menu.
 * - Already in a list    →  "✓ En cours" pill that opens a dropdown to
 *                            move between statuses or remove.
 *
 * Built on the same useEditAnilistListEntry / useDeleteAnilistListEntry
 * hooks as the card hover menu, just bigger / labelled for the hero.
 */
import { AL_MediaListStatus } from "@/api/generated/types"
import { useDeleteAnilistListEntry, useEditAnilistListEntry } from "@/api/hooks/anilist.hooks"
import { useActiveProfileId, useProfileListActions, ProfileListEntry } from "@/lib/profiles/profiles"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiCheck, BiChevronDown, BiPlus, BiTrash } from "react-icons/bi"

type Props = {
    mediaId: number
    currentStatus?: AL_MediaListStatus | null
    className?: string
}

const STATUS_ORDER: AL_MediaListStatus[] = ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED"]

const STATUS_I18N: Record<AL_MediaListStatus, string> = {
    CURRENT: "lists.tabs.current",
    PLANNING: "lists.tabs.planning",
    COMPLETED: "lists.tabs.completed",
    PAUSED: "lists.tabs.paused",
    DROPPED: "lists.tabs.dropped",
    REPEATING: "lists.tabs.current",
}

export function NetflixListPickerButton({ mediaId, currentStatus, className }: Props) {
    const { t } = useTranslation()
    const { mutate: edit, isPending: editing } = useEditAnilistListEntry(mediaId, "anime")
    const { mutate: remove, isPending: removing } = useDeleteAnilistListEntry(mediaId, "anime", () => { /* invalidated by hook */ })

    // When a profile is active, EVERY status change is dual-written:
    //  - AniList (so progress sync keeps working at the account level)
    //  - notflix_profile_list_entries for THIS profile (so the per-profile
    //    "Mes listes" view stays isolated). The shared AniList account is
    //    intentionally still the global source of truth for progress.
    const activeProfileId = useActiveProfileId()
    const { upsert: profileUpsert, remove: profileRemove } = useProfileListActions()

    const inAList = !!currentStatus
    const busy = editing || removing

    const moveTo = (status: AL_MediaListStatus) => {
        edit({ mediaId, status, type: "anime" })
        if (activeProfileId) {
            void profileUpsert(mediaId, status as ProfileListEntry["status"])
        }
    }

    const onDelete = () => {
        if (!confirm(t("lists.actions.delete_confirm"))) return
        if (activeProfileId) {
            // Profile-only delete by default — AniList stays untouched so
            // progress history of OTHER profiles isn't nuked. The user can
            // wipe AniList separately from anilist.co if they want.
            void profileRemove(mediaId)
        } else {
            remove({ mediaId, type: "anime" })
        }
    }

    // The trigger looks different depending on whether the anime is already
    // in a list — Netflix-y "+ Add" CTA vs a status pill that doubles as a
    // dropdown trigger.
    const trigger = inAList ? (
        <Button
            type="button"
            intent="white-subtle"
            size="lg"
            disabled={busy}
            leftIcon={<BiCheck className="text-brand-400" />}
            rightIcon={<BiChevronDown className="text-base opacity-80" />}
            className={cn("!rounded-md font-semibold", className)}
        >
            {t(STATUS_I18N[currentStatus!])}
        </Button>
    ) : (
        <Button
            type="button"
            intent="white-subtle"
            size="lg"
            disabled={busy}
            leftIcon={<BiPlus className="text-xl" />}
            className={cn("!rounded-md font-semibold", className)}
        >
            {t("lists.actions.add_to_list")}
        </Button>
    )

    return (
        <DropdownMenu trigger={trigger}>
            <div className="px-2 py-1 text-xs uppercase tracking-wider text-[--muted]">
                {inAList ? t("lists.actions.move_to") : t("lists.actions.add_to")}
            </div>
            {STATUS_ORDER.map(status => {
                const isActive = currentStatus === status
                return (
                    <DropdownMenuItem
                        key={status}
                        onClick={() => { if (!isActive) moveTo(status) }}
                    >
                        {isActive
                            ? <BiCheck className="text-brand-500" />
                            : <span className="size-4" aria-hidden />}
                        {t(STATUS_I18N[status])}
                    </DropdownMenuItem>
                )
            })}

            {inAList && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onDelete}>
                        <BiTrash className="text-red-400" />
                        {t("lists.actions.delete")}
                    </DropdownMenuItem>
                </>
            )}
        </DropdownMenu>
    )
}
