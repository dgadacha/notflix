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
import { useQuery } from "@tanstack/react-query"
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
import { LuActivity, LuArrowRight, LuDownload, LuGlobe, LuKey, LuPlay, LuServer, LuUpload, LuUsers } from "react-icons/lu"

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

            {me?.isAdmin && (
                <Section icon={<LuActivity className="size-5" />} title={t("settings.prowlarr_health", "État Prowlarr")}>
                    <ProwlarrHealthPanel />
                </Section>
            )}

            {me?.isAdmin && (
                <Section icon={<LuDownload className="size-5" />} title={t("settings.backup", "Sauvegarde")}>
                    <BackupPanel />
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

            <ProviderTestPanel />
        </div>
    )
}

// ---------------------------------------------------------------------------
// Test connection panel — live-ping each configured backend
// ---------------------------------------------------------------------------

type TestProvider = "tmdb" | "torbox" | "prowlarr" | "anthropic"
type TestResult = {
    state: "idle" | "running" | "ok" | "err"
    info?: string
    error?: string
}

function ProviderTestPanel() {
    const { t } = useTranslation()
    const [results, setResults] = React.useState<Record<TestProvider, TestResult>>({
        tmdb: { state: "idle" },
        torbox: { state: "idle" },
        prowlarr: { state: "idle" },
        anthropic: { state: "idle" },
    })

    const runOne = async (provider: TestProvider) => {
        setResults(r => ({ ...r, [provider]: { state: "running" } }))
        try {
            const res = await fetch(`/api/v1/admin/test/${provider}`, { method: "POST" })
            const j = await res.json()
            const data = j.data ?? j
            if (data?.ok) {
                setResults(r => ({ ...r, [provider]: { state: "ok", info: data.info } }))
            } else {
                setResults(r => ({ ...r, [provider]: { state: "err", error: data.error || `HTTP ${res.status}` } }))
            }
        } catch (e) {
            setResults(r => ({ ...r, [provider]: { state: "err", error: (e as Error).message } }))
        }
    }

    const runAll = () => {
        // Fire in parallel — server doesn't gate.
        void Promise.all([runOne("tmdb"), runOne("torbox"), runOne("prowlarr"), runOne("anthropic")])
    }

    const PROVIDERS: { key: TestProvider; label: string }[] = [
        { key: "tmdb", label: "TMDB" },
        { key: "torbox", label: "TorBox" },
        { key: "prowlarr", label: "Prowlarr" },
        { key: "anthropic", label: "Anthropic" },
    ]

    return (
        <div className="mt-4 pt-4 border-t border-white/10 space-y-2">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-white/70 font-semibold">
                    {t("settings.test_title", "Tester les connexions")}
                </p>
                <button
                    type="button"
                    onClick={runAll}
                    className={cn(
                        "px-2.5 py-1 rounded-md text-[11px] font-semibold",
                        "bg-white/10 hover:bg-white/15 text-white/90 transition-colors",
                    )}
                >
                    {t("settings.test_all", "Tout tester")}
                </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {PROVIDERS.map(p => (
                    <ProviderTestRow
                        key={p.key}
                        label={p.label}
                        result={results[p.key]}
                        onRun={() => void runOne(p.key)}
                    />
                ))}
            </div>
        </div>
    )
}

function ProviderTestRow({
    label,
    result,
    onRun,
}: {
    label: string
    result: TestResult
    onRun: () => void
}) {
    const { t } = useTranslation()
    const dotClass =
        result.state === "ok" ? "bg-emerald-400" :
            result.state === "err" ? "bg-red-400" :
                result.state === "running" ? "bg-amber-400 animate-pulse" :
                    "bg-white/30"

    return (
        <div className="flex items-center gap-2 rounded-md px-2.5 py-2 bg-black/30 border border-white/10">
            <span className={cn("size-2 rounded-full shrink-0", dotClass)} />
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5">
                    <span className="text-white text-xs font-semibold">{label}</span>
                    {result.state === "ok" && result.info && (
                        <span className="text-[10px] text-emerald-300/80 truncate" title={result.info}>
                            {result.info}
                        </span>
                    )}
                    {result.state === "err" && result.error && (
                        <span className="text-[10px] text-red-300/80 truncate" title={result.error}>
                            {result.error.length > 60 ? result.error.slice(0, 60) + "…" : result.error}
                        </span>
                    )}
                    {result.state === "running" && (
                        <span className="text-[10px] text-amber-300/80">
                            {t("settings.test_running", "test en cours…")}
                        </span>
                    )}
                </div>
            </div>
            <button
                type="button"
                onClick={onRun}
                disabled={result.state === "running"}
                className={cn(
                    "px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider",
                    "bg-white/10 hover:bg-white/15 text-white shrink-0",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
            >
                {t("settings.test_button", "Tester")}
            </button>
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

// ---------------------------------------------------------------------------
// Backup / Restore
// ---------------------------------------------------------------------------

function BackupPanel() {
    const { t } = useTranslation()
    const fileInputRef = React.useRef<HTMLInputElement>(null)
    const [busy, setBusy] = React.useState<"" | "export" | "import">("")
    const [feedback, setFeedback] = React.useState<{ kind: "ok" | "err"; msg: string } | null>(null)
    const [includeConfig, setIncludeConfig] = React.useState(true)

    const doExport = async () => {
        setBusy("export")
        setFeedback(null)
        try {
            const r = await fetch("/api/v1/admin/backup")
            if (!r.ok) throw new Error(`export ${r.status}`)
            // Build a download from the response body.
            const blob = await r.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            const cd = r.headers.get("content-disposition") || ""
            const m = /filename="([^"]+)"/.exec(cd)
            a.download = m?.[1] ?? `notflix-backup-${new Date().toISOString().slice(0, 10)}.json`
            document.body.appendChild(a)
            a.click()
            a.remove()
            URL.revokeObjectURL(url)
            setFeedback({ kind: "ok", msg: t("settings.backup_export_ok", "Sauvegarde téléchargée.") })
        } catch (e) {
            setFeedback({ kind: "err", msg: (e as Error).message })
        } finally {
            setBusy("")
        }
    }

    const doImport = async (file: File) => {
        setBusy("import")
        setFeedback(null)
        try {
            const body = await file.text()
            const url = "/api/v1/admin/backup/restore" + (includeConfig ? "?config=1" : "")
            const r = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            })
            const j = await r.json()
            if (!r.ok) throw new Error(j.error ?? `restore ${r.status}`)
            const d = j.data ?? j
            setFeedback({
                kind: "ok",
                msg: t(
                    "settings.backup_import_ok",
                    "Restauration réussie · {{p}} profils, {{h}} entrées d'historique, {{l}} entrées de listes{{c}}.",
                    {
                        p: d.profiles ?? 0,
                        h: d.history ?? 0,
                        l: d.listItems ?? 0,
                        c: d.configKeys ? t("settings.backup_import_config", ", clés serveur restaurées") : "",
                    },
                ),
            })
        } catch (e) {
            setFeedback({ kind: "err", msg: (e as Error).message })
        } finally {
            setBusy("")
        }
    }

    const onPickFile = () => fileInputRef.current?.click()

    return (
        <div className="space-y-3">
            <p className="text-[10px] text-[--muted]/70 leading-relaxed">
                {t(
                    "settings.backup_hint",
                    "Exporte un fichier JSON contenant les profils, l'historique, les listes et les clés serveur. Garde-le quelque part de sûr — c'est ta sauvegarde si la base SQLite est perdue.",
                )}
            </p>

            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={doExport}
                    disabled={busy !== ""}
                    className={cn(
                        "inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-semibold",
                        "bg-white/10 hover:bg-white/15 text-white transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                >
                    <LuDownload className="size-4" />
                    {busy === "export"
                        ? t("settings.backup_exporting", "Export en cours…")
                        : t("settings.backup_export", "Exporter la sauvegarde")}
                </button>

                <button
                    type="button"
                    onClick={onPickFile}
                    disabled={busy !== ""}
                    className={cn(
                        "inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-semibold",
                        "bg-brand-500/20 hover:bg-brand-500/30 text-brand-100 transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                >
                    <LuUpload className="size-4" />
                    {busy === "import"
                        ? t("settings.backup_importing", "Restauration en cours…")
                        : t("settings.backup_import", "Restaurer une sauvegarde")}
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void doImport(f)
                        // Reset so the same file can be re-uploaded.
                        e.target.value = ""
                    }}
                />
            </div>

            <label className="flex items-center gap-2 text-xs text-[--muted] cursor-pointer select-none pt-1">
                <input
                    type="checkbox"
                    checked={includeConfig}
                    onChange={(e) => setIncludeConfig(e.target.checked)}
                    className="accent-brand-500"
                />
                {t(
                    "settings.backup_restore_config",
                    "Restaurer aussi les clés serveur (TMDB / TorBox / Prowlarr / Anthropic) depuis la sauvegarde",
                )}
            </label>

            {feedback && (
                <p
                    className={cn(
                        "text-xs rounded-md px-3 py-2 border",
                        feedback.kind === "ok"
                            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                            : "bg-red-500/10 border-red-500/30 text-red-200",
                    )}
                >
                    {feedback.msg}
                </p>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Prowlarr health
// ---------------------------------------------------------------------------

type ProwlarrHealth = {
    configured: boolean
    up?: boolean
    appName?: string
    version?: string
    indexerCount?: number
    enabledIndexers?: number
    error?: string
    indexers?: Array<{
        id: number
        name: string
        enable: boolean
        protocol: string
        status: "up" | "degraded" | "down" | "unknown" | "disabled"
        queries: number
        failures: number
        averageResponseTimeMs: number
    }>
}

function useProwlarrHealth() {
    return useQuery<ProwlarrHealth>({
        queryKey: ["prowlarr", "health"],
        queryFn: async () => {
            const r = await fetch("/api/v1/prowlarr/health")
            if (!r.ok) throw new Error(`health ${r.status}`)
            const j = await r.json()
            return (j.data ?? j) as ProwlarrHealth
        },
        // Refresh whenever the panel comes into view + every 30 s.
        refetchOnWindowFocus: true,
        refetchInterval: 30_000,
        staleTime: 10_000,
    })
}

const STATUS_COLOR: Record<NonNullable<ProwlarrHealth["indexers"]>[number]["status"], string> = {
    up: "bg-emerald-400",
    degraded: "bg-amber-400",
    down: "bg-red-400",
    unknown: "bg-white/30",
    disabled: "bg-white/15",
}

function ProwlarrHealthPanel() {
    const { t } = useTranslation()
    const { data, isLoading, error } = useProwlarrHealth()

    if (isLoading) {
        return (
            <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-3/4" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-9 w-full" />
                    ))}
                </div>
            </div>
        )
    }
    if (error) {
        return (
            <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                {(error as Error)?.message ?? "load failed"}
            </p>
        )
    }
    if (!data || !data.configured) {
        return (
            <p className="text-[--muted] text-xs">
                {t("settings.prowlarr_not_configured",
                    "Prowlarr n'est pas configuré. Renseigne l'URL + la clé API ci-dessus.")}
            </p>
        )
    }
    if (data.up === false) {
        return (
            <div className="text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2 text-red-200 space-y-1">
                <p className="font-semibold">
                    {t("settings.prowlarr_down", "Prowlarr injoignable")}
                </p>
                {data.error && <p className="text-red-300/80">{data.error}</p>}
            </div>
        )
    }

    const indexers = data.indexers ?? []
    const counts = indexers.reduce(
        (acc, ix) => {
            acc[ix.status] = (acc[ix.status] || 0) + 1
            return acc
        },
        { up: 0, degraded: 0, down: 0, unknown: 0, disabled: 0 } as Record<string, number>,
    )

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
                <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                <span className="text-white font-semibold">
                    {data.appName ?? "Prowlarr"} v{data.version ?? "?"}
                </span>
                <span className="text-[--muted] text-xs">
                    · {data.enabledIndexers ?? 0}/{data.indexerCount ?? 0}{" "}
                    {t("settings.prowlarr_enabled_indexers", "indexers actifs")}
                </span>
            </div>

            {(counts.up + counts.degraded + counts.down + counts.unknown) > 0 && (
                <div className="flex flex-wrap gap-2 text-[11px] text-[--muted]">
                    {counts.up > 0 && (
                        <span className="inline-flex items-center gap-1">
                            <span className="size-1.5 rounded-full bg-emerald-400" /> {counts.up} {t("settings.prowlarr_status_up", "OK")}
                        </span>
                    )}
                    {counts.degraded > 0 && (
                        <span className="inline-flex items-center gap-1">
                            <span className="size-1.5 rounded-full bg-amber-400" /> {counts.degraded} {t("settings.prowlarr_status_degraded", "dégradé")}
                        </span>
                    )}
                    {counts.down > 0 && (
                        <span className="inline-flex items-center gap-1">
                            <span className="size-1.5 rounded-full bg-red-400" /> {counts.down} {t("settings.prowlarr_status_down", "down")}
                        </span>
                    )}
                    {counts.unknown > 0 && (
                        <span className="inline-flex items-center gap-1">
                            <span className="size-1.5 rounded-full bg-white/30" /> {counts.unknown} {t("settings.prowlarr_status_unknown", "inconnu")}
                        </span>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {indexers.map(ix => (
                    <div
                        key={ix.id}
                        className={cn(
                            "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs",
                            "bg-black/30 border border-white/10",
                            !ix.enable && "opacity-60",
                        )}
                    >
                        <span className={cn("size-2 rounded-full shrink-0", STATUS_COLOR[ix.status])} />
                        <span className="text-white font-medium truncate flex-1" title={ix.name}>
                            {ix.name}
                        </span>
                        {ix.queries > 0 && (
                            <span className="text-[--muted] text-[10px] tabular-nums shrink-0">
                                {ix.failures > 0
                                    ? `${ix.failures}/${ix.queries} ✗`
                                    : `${ix.averageResponseTimeMs}ms`}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}
