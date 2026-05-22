/**
 * Netflix "Qui regarde ?" screen — full-bleed black, centered grid of profile
 * cards. Mounted as the /profiles route. Manages add/edit/delete inline (no
 * separate /profiles/manage route; the "Gérer" toggle flips the grid into
 * edit mode).
 */
import {
    PROFILE_AVATARS,
    PROFILE_COLORS,
    Profile,
    useProfileActions,
} from "@/lib/profiles/profiles"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { Modal } from "@/components/ui/modal"
import { TextInput } from "@/components/ui/text-input"
import { useRouter } from "@/lib/navigation"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiPencil, BiPlus, BiTrash, BiX } from "react-icons/bi"

const MAX_PROFILES = 6  // matches Netflix's cap; keeps the grid balanced.

export function NetflixProfilePicker() {
    const { t } = useTranslation()
    const router = useRouter()
    const { profiles, add, update, remove, select } = useProfileActions()

    const [editing, setEditing] = React.useState(false)
    const [modalOpen, setModalOpen] = React.useState(false)
    const [draft, setDraft] = React.useState<Profile | null>(null)

    const onPick = (uid: string) => {
        select(uid)
        // Use a hard navigation instead of router.push: TanStack Router's
        // soft-nav races with jotai's atom-update commit and the layout-level
        // useProfileGate sometimes bounces us straight back to /profiles.
        // A full reload guarantees the next page boots with the active uid
        // already persisted in localStorage, and the gate sees it on first run.
        window.location.assign("/")
    }

    const openCreate = () => {
        setDraft(null)
        setModalOpen(true)
    }

    const openEdit = (profile: Profile) => {
        setDraft(profile)
        setModalOpen(true)
    }

    const onSubmit = async (data: Pick<Profile, "name" | "avatar" | "color">) => {
        if (draft) {
            await update(draft.uid, data)
        } else {
            await add(data)
        }
        setModalOpen(false)
    }

    const onDelete = async (uid: string) => {
        if (!confirm(t("profiles.delete_confirm"))) return
        await remove(uid)
    }

    const canAdd = profiles.length < MAX_PROFILES

    return (
        <div className="min-h-screen bg-black -mt-16 lg:-mt-[68px] flex flex-col items-center justify-center px-6 py-20">
            <h1 className="text-3xl lg:text-5xl font-extrabold text-white tracking-tight mb-12 text-center">
                {profiles.length === 0
                    ? t("profiles.welcome")
                    : t("profiles.who_is_watching")}
            </h1>

            <div className="flex flex-wrap items-start justify-center gap-6 lg:gap-10 max-w-5xl">
                {profiles.map(profile => (
                    <ProfileCard
                        key={profile.uid}
                        profile={profile}
                        editing={editing}
                        onPick={() => onPick(profile.uid)}
                        onEdit={() => openEdit(profile)}
                        onDelete={() => onDelete(profile.uid)}
                    />
                ))}

                {canAdd && !editing && (
                    <button
                        type="button"
                        onClick={openCreate}
                        aria-label={t("profiles.add")}
                        className="group flex flex-col items-center gap-3 outline-none"
                    >
                        <div
                            className={cn(
                                "size-28 lg:size-36 rounded-md border-2 border-dashed border-white/30",
                                "flex items-center justify-center",
                                "group-hover:border-white group-hover:bg-white/5 transition-colors",
                                "group-focus-visible:ring-2 group-focus-visible:ring-brand-500",
                            )}
                        >
                            <BiPlus className="text-5xl lg:text-6xl text-white/60 group-hover:text-white" />
                        </div>
                        <span className="text-sm lg:text-base text-[--muted] group-hover:text-white">
                            {t("profiles.add")}
                        </span>
                    </button>
                )}
            </div>

            {profiles.length > 0 && (
                <div className="mt-16">
                    <Button
                        intent={editing ? "primary" : "white-outline"}
                        size="md"
                        rounded
                        onClick={() => setEditing(e => !e)}
                        className="px-8 tracking-wide"
                    >
                        {editing ? t("profiles.done") : t("profiles.manage")}
                    </Button>
                </div>
            )}

            <ProfileFormModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                profile={draft}
                onSubmit={onSubmit}
            />
        </div>
    )
}

// -----------------------------------------------------------------------------
// One card
// -----------------------------------------------------------------------------

function ProfileCard({
    profile,
    editing,
    onPick,
    onEdit,
    onDelete,
}: {
    profile: Profile
    editing: boolean
    onPick: () => void
    onEdit: () => void
    onDelete: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center gap-3">
            <button
                type="button"
                onClick={editing ? onEdit : onPick}
                aria-label={editing ? `${t("profiles.edit")} – ${profile.name}` : `${t("profiles.select")} – ${profile.name}`}
                className={cn(
                    "group relative size-28 lg:size-36 rounded-md overflow-hidden",
                    "ring-0 ring-white transition-all duration-200",
                    "hover:ring-4 hover:scale-105 transform-gpu",
                    "focus-visible:ring-4 focus-visible:outline-none",
                )}
                style={{ backgroundColor: profile.color }}
            >
                <span className="absolute inset-0 flex items-center justify-center text-6xl lg:text-7xl">
                    {profile.avatar}
                </span>
                {editing && (
                    <span className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <BiPencil className="text-3xl text-white" />
                    </span>
                )}
            </button>

            <span className="text-sm lg:text-base text-[--muted] line-clamp-1 max-w-[8rem] lg:max-w-[10rem] text-center">
                {profile.name}
            </span>

            {editing && (
                <button
                    type="button"
                    onClick={onDelete}
                    className="text-xs text-[--muted] hover:text-red-400 inline-flex items-center gap-1 underline-offset-2 hover:underline"
                    aria-label={`${t("profiles.delete")} – ${profile.name}`}
                >
                    <BiTrash className="size-3" />
                    {t("profiles.delete")}
                </button>
            )}
        </div>
    )
}

// -----------------------------------------------------------------------------
// Add / Edit modal
// -----------------------------------------------------------------------------

function ProfileFormModal({
    open,
    onClose,
    profile,
    onSubmit,
}: {
    open: boolean
    onClose: () => void
    profile: Profile | null
    onSubmit: (data: Pick<Profile, "name" | "avatar" | "color">) => void
}) {
    const { t } = useTranslation()
    const [name, setName] = React.useState("")
    const [avatar, setAvatar] = React.useState<string>(PROFILE_AVATARS[0])
    const [color, setColor] = React.useState<string>(PROFILE_COLORS[0])

    // Reset form whenever the modal opens, populated from the profile being edited (if any).
    React.useEffect(() => {
        if (!open) return
        setName(profile?.name ?? "")
        setAvatar(profile?.avatar ?? PROFILE_AVATARS[0])
        setColor(profile?.color ?? PROFILE_COLORS[0])
    }, [open, profile])

    const submit = () => {
        const trimmed = name.trim()
        if (!trimmed) return
        onSubmit({ name: trimmed.slice(0, 30), avatar, color })
    }

    return (
        <Modal
            open={open}
            onOpenChange={onClose}
            title={profile ? t("profiles.edit") : t("profiles.add")}
            contentClass="max-w-md"
        >
            <div className="space-y-5">
                <div className="flex items-center justify-center">
                    <div
                        className="size-24 rounded-md flex items-center justify-center text-6xl"
                        style={{ backgroundColor: color }}
                        aria-hidden
                    >
                        {avatar}
                    </div>
                </div>

                <TextInput
                    autoFocus
                    label={t("profiles.name_label")}
                    placeholder={t("profiles.name_placeholder")}
                    maxLength={30}
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") submit() }}
                />

                <div className="space-y-2">
                    <p className="text-sm font-semibold text-white/90">{t("profiles.avatar_label")}</p>
                    <div className="grid grid-cols-8 gap-2">
                        {PROFILE_AVATARS.map(emoji => (
                            <button
                                key={emoji}
                                type="button"
                                onClick={() => setAvatar(emoji)}
                                aria-label={emoji}
                                aria-pressed={avatar === emoji}
                                className={cn(
                                    "aspect-square rounded-md text-2xl transition-all",
                                    "bg-white/5 hover:bg-white/15",
                                    avatar === emoji && "ring-2 ring-brand-500 bg-white/15",
                                )}
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="space-y-2">
                    <p className="text-sm font-semibold text-white/90">{t("profiles.color_label")}</p>
                    <div className="flex flex-wrap gap-2">
                        {PROFILE_COLORS.map(c => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setColor(c)}
                                aria-label={c}
                                aria-pressed={color === c}
                                className={cn(
                                    "size-9 rounded-full transition-all",
                                    color === c
                                        ? "ring-2 ring-white ring-offset-2 ring-offset-black scale-110"
                                        : "hover:scale-110",
                                )}
                                style={{ backgroundColor: c }}
                            />
                        ))}
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                    <Button intent="white-subtle" onClick={onClose} leftIcon={<BiX />}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        intent="primary"
                        onClick={submit}
                        disabled={!name.trim()}
                    >
                        {t("common.save")}
                    </Button>
                </div>
            </div>
        </Modal>
    )
}
