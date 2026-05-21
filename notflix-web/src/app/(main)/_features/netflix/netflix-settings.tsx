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
import { Skeleton } from "@/components/ui/skeleton"
import {
    ServerConfig,
    UpdateServerConfigBody,
    useChangeOwnPassword,
    useCurrentUser,
    useLogout,
    useServerConfig,
    useUpdateServerConfig,
} from "@/lib/auth"
import {
    AudioPref,
    AUDIO_OPTIONS,
    QualityPref,
    QUALITY_OPTIONS,
    SourcePickMode,
    useAudioPref,
    useQualityPref,
    useSourcePickMode,
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
import { LuArrowRight, LuGlobe, LuKey, LuPlay, LuServer, LuUsers } from "react-icons/lu"

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
                <SourcePicker />
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

            {me?.isAdmin && (
                <Section icon={<LuServer className="size-5" />} title={t("settings.server", "Configuration serveur")}>
                    <ServerConfigEditor />
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

function SourcePicker() {
    const { t } = useTranslation()
    const [value, setValue] = useSourcePickMode()
    // Localise the labels at render time — the constant module uses raw
    // French strings as a fallback so the picker still works if i18n
    // ever fails to initialise.
    const localized = [
        { value: "auto" as SourcePickMode, label: t("settings.source_auto", "Lecture automatique") },
        { value: "manual" as SourcePickMode, label: t("settings.source_manual", "Choisir la source") },
    ]
    return (
        <div className="space-y-1">
            <PrefPills<SourcePickMode>
                label={t("settings.source_pick", "Lecture des sources")}
                options={localized}
                value={value}
                onChange={setValue}
            />
            <p className="text-[10px] text-[--muted]/70 leading-relaxed">
                {value === "auto"
                    ? t(
                        "settings.source_auto_hint",
                        "Notflix lance directement la meilleure source (cache TorBox + seeders + qualité). Tu peux toujours changer en cours de lecture.",
                    )
                    : t(
                        "settings.source_manual_hint",
                        "À chaque film/épisode, la liste complète des sources s'affiche et tu choisis celle à lancer.",
                    )}
            </p>
        </div>
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
// Configuration serveur (admin-only) — TMDB / TorBox / Prowlarr credentials
// ---------------------------------------------------------------------------
//
// Each field is rendered as a row showing the masked tail (****abcd) plus
// "env" or "DB" pill telling the admin where the value currently comes from.
// Editing replaces the row with an input + Save/Cancel. The save sends only
// the field being edited so other rows aren't disturbed (the PUT endpoint
// supports partial bodies). An empty save deliberately CLEARS the override.

function ServerConfigEditor() {
    const { t } = useTranslation()
    const { data, isLoading, error } = useServerConfig()

    if (isLoading) {
        return (
            <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="bg-black/30 border border-white/10 rounded-md p-3 lg:p-3.5 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                            <Skeleton className="h-4 w-28" />
                            <Skeleton className="h-6 w-16 rounded-md" />
                        </div>
                        <Skeleton className="h-3 w-3/4" />
                    </div>
                ))}
            </div>
        )
    }
    if (error || !data) {
        return (
            <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                {error?.message || t("settings.server_load_error", "Impossible de charger la configuration.")}
            </p>
        )
    }

    return (
        <div className="space-y-3">
            <p className="text-[10px] text-[--muted]/70 leading-relaxed">
                {t(
                    "settings.server_hint",
                    "Modifie ici les clés API utilisées par le backend. La valeur est appliquée à chaud — pas besoin de redémarrer. Les variables d'environnement (NOTFLIX_*) restent le fallback initial.",
                )}
            </p>

            <ServerSecretRow
                label="TMDB"
                description={t("settings.server_tmdb", "Clé API pour le catalogue (themoviedb.org).")}
                field={data.tmdbApiKey}
                bodyKey="tmdbApiKey"
            />
            <ServerSecretRow
                label="TorBox"
                description={t("settings.server_torbox", "Clé API debrid (torbox.app).")}
                field={data.torboxApiKey}
                bodyKey="torboxApiKey"
            />
            <ServerUrlRow
                label={t("settings.server_prowlarr_url", "URL Prowlarr")}
                description={t(
                    "settings.server_prowlarr_url_hint",
                    "Adresse de ton instance Prowlarr (ex: http://127.0.0.1:9696).",
                )}
                value={data.prowlarrUrl.value}
                source={data.prowlarrUrl.source}
                bodyKey="prowlarrUrl"
            />
            <ServerSecretRow
                label={t("settings.server_prowlarr_key", "Clé API Prowlarr")}
                description={t(
                    "settings.server_prowlarr_key_hint",
                    "Visible dans Prowlarr → Settings → General → API Key.",
                )}
                field={data.prowlarrApiKey}
                bodyKey="prowlarrApiKey"
            />
            <ServerSecretRow
                label={t("settings.server_anthropic_key", "Clé API Anthropic")}
                description={t(
                    "settings.server_anthropic_key_hint",
                    "Optionnel — active la traduction de sous-titres en direct via Claude. Sans clé, seuls les sous-titres natifs du fichier sont disponibles.",
                )}
                field={data.anthropicApiKey}
                bodyKey="anthropicApiKey"
            />
            <ServerUrlRow
                label={t("settings.server_anthropic_model", "Modèle Anthropic")}
                description={t(
                    "settings.server_anthropic_model_hint",
                    "Modèle utilisé pour la traduction (ex: claude-haiku-4-5). Laisser vide pour le défaut.",
                )}
                value={data.anthropicModel.value}
                source={data.anthropicModel.source}
                bodyKey="anthropicModel"
            />
        </div>
    )
}

function ServerSecretRow({
    label,
    description,
    field,
    bodyKey,
}: {
    label: string
    description: string
    field: ServerConfig["tmdbApiKey"]
    bodyKey: keyof UpdateServerConfigBody
}) {
    const { t } = useTranslation()
    const [editing, setEditing] = React.useState(false)
    const [draft, setDraft] = React.useState("")
    const [reveal, setReveal] = React.useState(false)
    const update = useUpdateServerConfig()

    const onSave = () => {
        if (update.isPending) return
        update.mutate(
            { [bodyKey]: draft } as UpdateServerConfigBody,
            {
                onSuccess: () => {
                    setEditing(false)
                    setDraft("")
                    setReveal(false)
                },
            },
        )
    }

    const onCancel = () => {
        setEditing(false)
        setDraft("")
        setReveal(false)
        update.reset()
    }

    return (
        <div className="bg-black/30 border border-white/10 rounded-md p-3 lg:p-3.5 space-y-2">
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-semibold flex items-center gap-2">
                        <LuKey className="size-3.5 text-[--muted]" />
                        {label}
                        <SourcePill field={field} />
                    </p>
                    <p className="text-[--muted] text-xs leading-relaxed">{description}</p>
                </div>
                {!editing && (
                    <button
                        type="button"
                        onClick={() => {
                            setEditing(true)
                            update.reset()
                        }}
                        className="px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md bg-white/10 hover:bg-white/15 text-white shrink-0 transition-colors"
                    >
                        {field.isSet
                            ? t("settings.server_replace", "Modifier")
                            : t("settings.server_set", "Définir")}
                    </button>
                )}
            </div>

            {!editing && field.isSet && (
                <p className="font-mono text-[11px] text-[--muted] break-all">{field.masked}</p>
            )}

            {editing && (
                <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded-md focus-within:border-brand-500/60 transition-colors">
                        <LuKey className="size-4 text-[--muted] shrink-0" />
                        <input
                            type={reveal ? "text" : "password"}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            placeholder={
                                field.isSet
                                    ? t("settings.server_keep_blank", "Laisser vide pour effacer")
                                    : t("settings.server_paste", "Coller la nouvelle clé…")
                            }
                            className="w-full bg-transparent text-white outline-none text-sm font-mono"
                        />
                        <button
                            type="button"
                            onClick={() => setReveal((v) => !v)}
                            className="text-[--muted] hover:text-white text-[10px] uppercase tracking-wider font-bold shrink-0"
                        >
                            {reveal ? t("settings.server_hide", "Masquer") : t("settings.server_show", "Afficher")}
                        </button>
                    </div>

                    {update.error && (
                        <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                            {update.error.message}
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md bg-white/5 hover:bg-white/10 text-white transition-colors"
                        >
                            {t("common.cancel", "Annuler")}
                        </button>
                        <button
                            type="button"
                            onClick={onSave}
                            disabled={update.isPending}
                            className={cn(
                                "px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-colors",
                                "bg-brand-500 hover:bg-brand-600 text-white",
                                "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand-500",
                            )}
                        >
                            {update.isPending
                                ? t("common.saving", "Enregistrement…")
                                : t("settings.password_save", "Enregistrer")}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

function ServerUrlRow({
    label,
    description,
    value,
    source,
    bodyKey,
}: {
    label: string
    description: string
    value: string
    source: "env" | "db"
    bodyKey: keyof UpdateServerConfigBody
}) {
    const { t } = useTranslation()
    const [editing, setEditing] = React.useState(false)
    const [draft, setDraft] = React.useState("")
    const update = useUpdateServerConfig()

    const onStart = () => {
        setDraft(value)
        setEditing(true)
        update.reset()
    }

    const onSave = () => {
        if (update.isPending) return
        update.mutate(
            { [bodyKey]: draft.trim() } as UpdateServerConfigBody,
            {
                onSuccess: () => {
                    setEditing(false)
                    setDraft("")
                },
            },
        )
    }

    return (
        <div className="bg-black/30 border border-white/10 rounded-md p-3 lg:p-3.5 space-y-2">
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-semibold flex items-center gap-2">
                        <LuServer className="size-3.5 text-[--muted]" />
                        {label}
                        <SourcePill field={{ isSet: value !== "", source }} />
                    </p>
                    <p className="text-[--muted] text-xs leading-relaxed">{description}</p>
                </div>
                {!editing && (
                    <button
                        type="button"
                        onClick={onStart}
                        className="px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md bg-white/10 hover:bg-white/15 text-white shrink-0 transition-colors"
                    >
                        {value ? t("settings.server_replace", "Modifier") : t("settings.server_set", "Définir")}
                    </button>
                )}
            </div>

            {!editing && value && (
                <p className="font-mono text-[11px] text-[--muted] break-all">{value}</p>
            )}

            {editing && (
                <div className="space-y-2 pt-1">
                    <div className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded-md focus-within:border-brand-500/60 transition-colors">
                        <input
                            type="text"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="http://127.0.0.1:9696"
                            className="w-full bg-transparent text-white outline-none text-sm font-mono"
                        />
                    </div>

                    {update.error && (
                        <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                            {update.error.message}
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setEditing(false)
                                setDraft("")
                                update.reset()
                            }}
                            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md bg-white/5 hover:bg-white/10 text-white transition-colors"
                        >
                            {t("common.cancel", "Annuler")}
                        </button>
                        <button
                            type="button"
                            onClick={onSave}
                            disabled={update.isPending}
                            className={cn(
                                "px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md transition-colors",
                                "bg-brand-500 hover:bg-brand-600 text-white",
                                "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand-500",
                            )}
                        >
                            {update.isPending
                                ? t("common.saving", "Enregistrement…")
                                : t("settings.password_save", "Enregistrer")}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

function SourcePill({ field }: { field: { isSet: boolean; source: "env" | "db" } }) {
    const { t } = useTranslation()
    if (!field.isSet) {
        return (
            <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300">
                {t("settings.server_source_unset", "non défini")}
            </span>
        )
    }
    if (field.source === "db") {
        return (
            <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-brand-500/20 text-brand-300">
                {t("settings.server_source_db", "UI")}
            </span>
        )
    }
    return (
        <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-white/10 text-[--muted]">
            {t("settings.server_source_env", "env")}
        </span>
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
