/**
 * Notflix settings page.
 *
 * Six vertically-stacked sections, each rendered as a translucent card on
 * the Netflix-black background:
 *
 *   1. Compte               — current user, change own password, sign out
 *   2. Préférences          — quality / audio radio pills (existing atoms)
 *   3. Langue de l'interface — FR / EN switch (react-i18next + localStorage)
 *   4. Profils              — count + shortcut to /profiles
 *   5. Administration       — admin-only shortcut to /admin/users
 *   6. À propos             — Notflix mission statement, link to repo
 *
 * Everything that can be persisted is — preferences go through the same
 * jotai atomWithStorage atoms the player + modal already read from, so
 * a change here applies on the very next /watch open without a refresh.
 */
import { LanguageSwitcher } from "@/components/shared/language-switcher"
import { cn } from "@/components/ui/core/styling"
import { useChangeOwnPassword, useCurrentUser, useLogout } from "@/lib/auth"
import {
    AudioPref,
    AUDIO_OPTIONS,
    QualityPref,
    QUALITY_OPTIONS,
    useAudioPref,
    useQualityPref,
} from "@/lib/preferences"
import { useProfilesQuery } from "@/lib/profiles/profiles"
import { useRouter } from "@/lib/navigation"
import React from "react"
import { useTranslation } from "react-i18next"
import {
    BiInfoCircle,
    BiLockAlt,
    BiLogOut,
    BiShield,
    BiUser,
} from "react-icons/bi"
import { LuArrowRight, LuGlobe, LuPlay, LuUsers } from "react-icons/lu"

export function NetflixSettings() {
    const { t } = useTranslation()
    const { data: me } = useCurrentUser()
    const router = useRouter()
    const { profiles } = useProfilesQuery()

    return (
        <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-10 space-y-6 lg:space-y-8 max-w-3xl mx-auto">
            <header className="space-y-1">
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                    {t("settings.title", "Paramètres")}
                </h1>
                <p className="text-[--muted] text-sm">
                    {t(
                        "settings.subtitle",
                        "Préférences de lecture, langue de l'interface et gestion du compte.",
                    )}
                </p>
            </header>

            {me && (
                <Section icon={<BiUser className="size-5" />} title={t("settings.account", "Compte")}>
                    <AccountSummary />
                    <ChangePasswordForm />
                    <LogoutRow />
                </Section>
            )}

            <Section icon={<LuPlay className="size-5" />} title={t("settings.playback", "Préférences de lecture")}>
                <QualityPicker />
                <AudioPicker />
                <p className="text-[10px] text-[--muted]/70 leading-relaxed pt-1">
                    {t(
                        "settings.playback_note",
                        "Appliqué automatiquement quand Notflix choisit une release. Tu pourras toujours forcer une autre source depuis la fiche du film.",
                    )}
                </p>
            </Section>

            <Section icon={<LuGlobe className="size-5" />} title={t("settings.language", "Langue de l'interface")}>
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-white">
                        {t("settings.language_label", "Langue de l'application")}
                    </span>
                    <LanguageSwitcher />
                </div>
            </Section>

            <Section icon={<LuUsers className="size-5" />} title={t("settings.profiles", "Profils")}>
                <NavRow
                    primary={
                        profiles.length === 0
                            ? t("settings.profiles_none", "Aucun profil pour le moment")
                            : t("settings.profiles_count", "{{count}} profil(s)", { count: profiles.length })
                    }
                    secondary={t(
                        "settings.profiles_hint",
                        "Chaque profil garde son propre Reprendre + Ma liste.",
                    )}
                    cta={
                        profiles.length === 0
                            ? t("profiles.enable", "Activer les profils")
                            : t("profiles.manage", "Gérer les profils")
                    }
                    onClick={() => router.push("/profiles")}
                />
            </Section>

            {me?.isAdmin && (
                <Section icon={<BiShield className="size-5" />} title={t("settings.admin", "Administration")}>
                    <NavRow
                        primary={t("settings.admin_users", "Comptes utilisateurs")}
                        secondary={t(
                            "settings.admin_users_hint",
                            "Créer, supprimer ou réinitialiser le mot de passe des membres du foyer.",
                        )}
                        cta={t("settings.admin_open", "Ouvrir")}
                        onClick={() => router.push("/admin/users")}
                    />
                </Section>
            )}

            <Section icon={<BiInfoCircle className="size-5" />} title={t("settings.about", "À propos")}>
                <p className="text-sm text-white/90 leading-relaxed">
                    <strong>Notflix</strong>{" "}
                    {t(
                        "settings.about_blurb",
                        "— interface de streaming auto-hébergée. TMDB pour le catalogue, Prowlarr pour la recherche, TorBox pour le debrid, ffmpeg pour la transmuxion audio à la volée.",
                    )}
                </p>
                <a
                    href="https://github.com/dgadacha/notflix"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-brand-300 hover:text-brand-200 text-sm font-semibold mt-2"
                >
                    github.com/dgadacha/notflix
                    <LuArrowRight className="size-4" />
                </a>
            </Section>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Section shell — translucent card matching the rest of the Netflix UI
// ---------------------------------------------------------------------------

function Section({
    icon,
    title,
    children,
}: {
    icon: React.ReactNode
    title: string
    children: React.ReactNode
}) {
    return (
        <section className="bg-white/5 border border-white/10 rounded-xl p-4 lg:p-5 space-y-4">
            <h2 className="text-base lg:text-lg font-bold text-white flex items-center gap-2">
                <span className="text-brand-400">{icon}</span>
                {title}
            </h2>
            {children}
        </section>
    )
}

// ---------------------------------------------------------------------------
// Compte
// ---------------------------------------------------------------------------

function AccountSummary() {
    const { t } = useTranslation()
    const { data: me } = useCurrentUser()
    if (!me) return null

    return (
        <div className="flex items-center gap-3">
            <div
                className={cn(
                    "size-11 rounded-full flex items-center justify-center shrink-0",
                    me.isAdmin ? "bg-brand-500/20 text-brand-300" : "bg-white/10 text-white",
                )}
            >
                {me.isAdmin ? <BiShield className="size-5" /> : <BiUser className="size-5" />}
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-white font-semibold truncate">
                    {me.displayName || me.username}
                    {me.isAdmin && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-brand-300 font-bold">
                            {t("settings.admin_badge", "admin")}
                        </span>
                    )}
                </p>
                <p className="text-[--muted] text-xs truncate">@{me.username}</p>
            </div>
        </div>
    )
}

function ChangePasswordForm() {
    const { t } = useTranslation()
    const [open, setOpen] = React.useState(false)
    const [current, setCurrent] = React.useState("")
    const [next, setNext] = React.useState("")
    const [confirmPwd, setConfirmPwd] = React.useState("")
    const [ok, setOk] = React.useState(false)
    const change = useChangeOwnPassword()

    const reset = () => {
        setCurrent("")
        setNext("")
        setConfirmPwd("")
    }

    const mismatch = next.length > 0 && confirmPwd.length > 0 && next !== confirmPwd
    const tooShort = next.length > 0 && next.length < 4

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (!current || !next || mismatch || tooShort || change.isPending) return
        change.mutate(
            { currentPassword: current, newPassword: next },
            {
                onSuccess: () => {
                    reset()
                    setOk(true)
                    setOpen(false)
                    window.setTimeout(() => setOk(false), 3000)
                },
            },
        )
    }

    if (!open) {
        return (
            <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-sm text-white">
                    {t("settings.password_label", "Mot de passe")}
                </span>
                <button
                    type="button"
                    onClick={() => {
                        setOpen(true)
                        change.reset()
                    }}
                    className={cn(
                        "px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md",
                        "bg-white/10 hover:bg-white/15 text-white transition-colors",
                    )}
                >
                    {t("settings.password_change", "Changer")}
                </button>
                {ok && (
                    <span className="text-[11px] text-green-300 font-semibold">
                        {t("settings.password_changed", "Mot de passe mis à jour ✓")}
                    </span>
                )}
            </div>
        )
    }

    return (
        <form
            onSubmit={onSubmit}
            className="bg-black/40 border border-white/10 rounded-md p-3 lg:p-4 space-y-3"
        >
            <PasswordField
                label={t("settings.password_current", "Mot de passe actuel")}
                value={current}
                onChange={setCurrent}
                autoComplete="current-password"
                autoFocus
            />
            <PasswordField
                label={t("settings.password_new", "Nouveau mot de passe")}
                value={next}
                onChange={setNext}
                autoComplete="new-password"
            />
            <PasswordField
                label={t("settings.password_confirm", "Confirmer le nouveau mot de passe")}
                value={confirmPwd}
                onChange={setConfirmPwd}
                autoComplete="new-password"
            />

            {(mismatch || tooShort || change.error) && (
                <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                    {tooShort
                        ? t("settings.password_too_short", "Le nouveau mot de passe doit faire au moins 4 caractères.")
                        : mismatch
                            ? t("settings.password_mismatch", "Les deux mots de passe ne correspondent pas.")
                            : change.error?.message}
                </p>
            )}

            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => {
                        setOpen(false)
                        reset()
                        change.reset()
                    }}
                    className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md bg-white/5 hover:bg-white/10 text-white transition-colors"
                >
                    {t("common.cancel", "Annuler")}
                </button>
                <button
                    type="submit"
                    disabled={change.isPending || !current || !next || mismatch || tooShort}
                    className={cn(
                        "px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-colors",
                        "bg-brand-500 hover:bg-brand-600 text-white",
                        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand-500",
                    )}
                >
                    {change.isPending
                        ? t("common.saving", "Enregistrement…")
                        : t("settings.password_save", "Enregistrer")}
                </button>
            </div>
        </form>
    )
}

function PasswordField({
    label,
    value,
    onChange,
    autoComplete,
    autoFocus,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    autoComplete: string
    autoFocus?: boolean
}) {
    return (
        <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-[--muted] font-semibold">
                {label}
            </span>
            <span
                className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-md",
                    "bg-white/5 border border-white/10",
                    "focus-within:border-brand-500/60 transition-colors",
                )}
            >
                <BiLockAlt className="size-4 text-[--muted] shrink-0" />
                <input
                    type="password"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    autoComplete={autoComplete}
                    autoFocus={autoFocus}
                    className="w-full bg-transparent text-white outline-none text-sm"
                />
            </span>
        </label>
    )
}

function LogoutRow() {
    const { t } = useTranslation()
    const logout = useLogout()
    return (
        <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-sm text-white">
                {t("settings.logout_label", "Se déconnecter de cet appareil")}
            </span>
            <button
                type="button"
                onClick={() => logout.mutate()}
                className={cn(
                    "px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md inline-flex items-center gap-1.5",
                    "bg-white/10 hover:bg-red-500/40 text-white transition-colors",
                )}
            >
                <BiLogOut className="size-3.5" />
                {t("nav.logout", "Déconnexion")}
            </button>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Préférences de lecture
// ---------------------------------------------------------------------------

function QualityPicker() {
    const { t } = useTranslation()
    const [value, setValue] = useQualityPref()
    return (
        <PrefPills<QualityPref>
            label={t("settings.quality", "Qualité préférée")}
            options={QUALITY_OPTIONS}
            value={value}
            onChange={setValue}
        />
    )
}

function AudioPicker() {
    const { t } = useTranslation()
    const [value, setValue] = useAudioPref()
    return (
        <PrefPills<AudioPref>
            label={t("settings.audio", "Piste audio préférée")}
            options={AUDIO_OPTIONS}
            value={value}
            onChange={setValue}
        />
    )
}

function PrefPills<T extends string>({
    label,
    options,
    value,
    onChange,
}: {
    label: string
    options: { value: T; label: string }[]
    value: T
    onChange: (v: T) => void
}) {
    return (
        <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-[--muted] font-semibold">
                {label}
            </p>
            <div className="flex flex-wrap gap-1.5">
                {options.map((opt) => {
                    const active = opt.value === value
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => onChange(opt.value)}
                            className={cn(
                                "px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors",
                                active
                                    ? "bg-brand-500 border-brand-500 text-white"
                                    : "bg-white/5 border-white/10 text-[--muted] hover:text-white hover:border-white/20",
                            )}
                        >
                            {opt.label}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Generic clickable row used by Profils + Administration
// ---------------------------------------------------------------------------

function NavRow({
    primary,
    secondary,
    cta,
    onClick,
}: {
    primary: string
    secondary?: string
    cta: string
    onClick: () => void
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-semibold">{primary}</p>
                {secondary && (
                    <p className="text-[--muted] text-xs leading-relaxed">{secondary}</p>
                )}
            </div>
            <button
                type="button"
                onClick={onClick}
                className={cn(
                    "px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md shrink-0",
                    "bg-white/10 hover:bg-white/15 text-white transition-colors inline-flex items-center gap-1.5",
                )}
            >
                {cta}
                <LuArrowRight className="size-3.5" />
            </button>
        </div>
    )
}
