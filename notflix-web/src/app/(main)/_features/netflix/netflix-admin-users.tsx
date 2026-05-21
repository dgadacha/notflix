/**
 * /admin/users — the admin-only page where the parent account creates
 * child users (e.g. one per family member), resets their passwords or
 * removes them. Non-admin users get a 403 banner because the same
 * permission check fires on the backend.
 */
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import {
    CurrentUser,
    useCreateUser,
    useCurrentUser,
    useDeleteUser,
    useResetUserPassword,
    useUsers,
} from "@/lib/auth"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiKey, BiPlus, BiShield, BiTrash, BiUser } from "react-icons/bi"

export function NetflixAdminUsers() {
    const { t } = useTranslation()
    const { data: me } = useCurrentUser()
    const { data: users = [], isLoading } = useUsers()

    if (!me || !me.isAdmin) {
        return (
            <div className="px-4 sm:px-6 lg:px-16 py-12 max-w-2xl mx-auto text-center space-y-3">
                <h1 className="text-2xl lg:text-3xl font-extrabold text-white">
                    {t("admin.users.title", "Administration des comptes")}
                </h1>
                <p className="text-[--muted]">
                    {t("admin.users.forbidden", "Cette page est réservée aux comptes administrateur.")}
                </p>
            </div>
        )
    }

    return (
        <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-8 space-y-6 lg:space-y-8 max-w-4xl mx-auto">
            <div className="space-y-1">
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                    {t("admin.users.title", "Administration des comptes")}
                </h1>
                <p className="text-[--muted] text-sm">
                    {t(
                        "admin.users.subtitle",
                        "Créez un compte pour chaque membre de la famille. Les enfants ne peuvent pas créer d'autres comptes ni en supprimer.",
                    )}
                </p>
            </div>

            <CreateUserForm />

            <section className="space-y-3">
                <h2 className="text-lg lg:text-xl font-bold text-white">
                    {t("admin.users.existing", "Comptes existants")}
                </h2>
                {isLoading ? (
                    <div className="text-[--muted] text-sm">{t("common.loading", "Chargement…")}</div>
                ) : users.length === 0 ? (
                    <div className="text-[--muted] text-sm">{t("admin.users.empty", "Aucun compte.")}</div>
                ) : (
                    <ul className="space-y-2">
                        {users.map((u) => (
                            <UserRow key={u.id} user={u} meId={me.id} />
                        ))}
                    </ul>
                )}
            </section>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

function CreateUserForm() {
    const { t } = useTranslation()
    const [username, setUsername] = React.useState("")
    const [password, setPassword] = React.useState("")
    const [displayName, setDisplayName] = React.useState("")
    const [isAdmin, setIsAdmin] = React.useState(false)
    const create = useCreateUser()

    const reset = () => {
        setUsername("")
        setPassword("")
        setDisplayName("")
        setIsAdmin(false)
    }

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (!username || !password || create.isPending) return
        create.mutate(
            { username, password, displayName: displayName || undefined, isAdmin },
            {
                onSuccess: () => reset(),
            },
        )
    }

    return (
        <form
            onSubmit={onSubmit}
            className="bg-white/5 border border-white/10 rounded-xl p-4 lg:p-5 space-y-4"
        >
            <h2 className="text-base lg:text-lg font-bold text-white flex items-center gap-2">
                <BiPlus className="size-5" />
                {t("admin.users.new", "Créer un compte")}
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <InputField
                    label={t("admin.users.field_username", "Identifiant")}
                    value={username}
                    onChange={setUsername}
                    placeholder="ex: emma"
                    autoComplete="off"
                />
                <InputField
                    label={t("admin.users.field_display_name", "Nom affiché (optionnel)")}
                    value={displayName}
                    onChange={setDisplayName}
                    placeholder="ex: Emma"
                />
                <InputField
                    label={t("admin.users.field_password", "Mot de passe")}
                    value={password}
                    onChange={setPassword}
                    type="password"
                    placeholder="min. 4 caractères"
                    autoComplete="new-password"
                />
                <label className="flex items-end gap-2 text-sm text-white pb-1 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={isAdmin}
                        onChange={(e) => setIsAdmin(e.target.checked)}
                        className="size-4 accent-brand-500"
                    />
                    <span>{t("admin.users.field_is_admin", "Compte administrateur")}</span>
                </label>
            </div>

            {create.error && (
                <p className="text-red-300 text-sm bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                    {create.error.message}
                </p>
            )}

            <div className="flex justify-end">
                <Button
                    type="submit"
                    disabled={create.isPending || !username || !password}
                    intent="primary"
                    className="rounded-md"
                >
                    {create.isPending ? t("common.saving", "Création…") : t("admin.users.create", "Créer")}
                </Button>
            </div>
        </form>
    )
}

// ---------------------------------------------------------------------------
// Existing user row
// ---------------------------------------------------------------------------

function UserRow({ user, meId }: { user: CurrentUser; meId: number }) {
    const { t } = useTranslation()
    const del = useDeleteUser()
    const reset = useResetUserPassword()
    const [resetting, setResetting] = React.useState(false)
    const [newPassword, setNewPassword] = React.useState("")

    const isSelf = user.id === meId

    const onConfirmDelete = () => {
        if (!confirm(t("admin.users.confirm_delete", "Supprimer ce compte ?"))) return
        del.mutate(user.id)
    }

    const onSubmitReset = (e: React.FormEvent) => {
        e.preventDefault()
        if (!newPassword) return
        reset.mutate(
            { id: user.id, password: newPassword },
            {
                onSuccess: () => {
                    setNewPassword("")
                    setResetting(false)
                },
            },
        )
    }

    return (
        <li className="bg-white/5 border border-white/10 rounded-lg p-3 lg:p-4 space-y-3">
            <div className="flex items-center gap-3">
                <div
                    className={cn(
                        "size-9 lg:size-10 rounded-full flex items-center justify-center shrink-0",
                        user.isAdmin ? "bg-brand-500/20 text-brand-300" : "bg-white/10 text-white",
                    )}
                >
                    {user.isAdmin ? <BiShield className="size-5" /> : <BiUser className="size-5" />}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold truncate">
                        {user.displayName || user.username}
                        {user.isAdmin && (
                            <span className="ml-2 text-[10px] uppercase tracking-wider text-brand-300 font-bold">
                                admin
                            </span>
                        )}
                    </p>
                    <p className="text-[--muted] text-xs truncate">@{user.username}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => setResetting((v) => !v)}
                        aria-label={t("admin.users.reset_password", "Nouveau mot de passe")}
                        className="p-2 rounded-md text-white hover:bg-white/10"
                    >
                        <BiKey className="size-4" />
                    </button>
                    {!isSelf && (
                        <button
                            type="button"
                            onClick={onConfirmDelete}
                            aria-label={t("admin.users.delete", "Supprimer")}
                            disabled={del.isPending}
                            className="p-2 rounded-md text-white hover:bg-red-500/40 disabled:opacity-50"
                        >
                            <BiTrash className="size-4" />
                        </button>
                    )}
                </div>
            </div>

            {resetting && (
                <form onSubmit={onSubmitReset} className="flex items-center gap-2">
                    <input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={t("admin.users.new_password", "Nouveau mot de passe")}
                        autoComplete="new-password"
                        className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-md text-white text-sm"
                    />
                    <Button
                        type="submit"
                        size="sm"
                        intent="primary"
                        disabled={reset.isPending || newPassword.length < 4}
                        className="rounded-md"
                    >
                        {t("admin.users.apply", "Appliquer")}
                    </Button>
                </form>
            )}
        </li>
    )
}

function InputField({
    label,
    value,
    onChange,
    type = "text",
    placeholder,
    autoComplete,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    type?: string
    placeholder?: string
    autoComplete?: string
}) {
    return (
        <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-[--muted] font-semibold">
                {label}
            </span>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                autoComplete={autoComplete}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-md text-white placeholder:text-[--muted]"
            />
        </label>
    )
}
