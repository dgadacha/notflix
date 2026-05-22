/**
 * Sign-in screen. Rendered by MainLayout when /api/v1/auth/me returns
 * 401 — no separate /login route, so any deep link survives the round
 * trip through auth.
 */
import { cn } from "@/components/ui/core/styling"
import { useLogin } from "@/lib/auth"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiLockAlt, BiUser } from "react-icons/bi"

export function NetflixLogin() {
    const { t } = useTranslation()
    const [username, setUsername] = React.useState("")
    const [password, setPassword] = React.useState("")
    const login = useLogin()

    const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (!username || !password || login.isPending) return
        login.mutate({ username, password })
    }

    return (
        <div className="min-h-screen w-full bg-black flex items-center justify-center px-4 py-10 relative overflow-hidden">
            {/* Subtle red glow behind the card — pure CSS, no asset. */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(229,9,20,0.18),transparent_60%)]" />

            <form
                onSubmit={onSubmit}
                className={cn(
                    "relative z-[1] w-full max-w-md space-y-6",
                    "bg-[#0a0a0a]/90 backdrop-blur border border-white/5 rounded-2xl",
                    "p-6 sm:p-8 shadow-2xl",
                )}
            >
                <div className="flex flex-col items-center gap-2">
                    <img src="/notflix-logo.svg" alt="" className="size-12 lg:size-14" />
                    <h1 className="text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
                        Notflix
                    </h1>
                    <p className="text-[--muted] text-xs lg:text-sm">
                        {t("login.subtitle", "Connectez-vous pour continuer")}
                    </p>
                </div>

                <div className="space-y-3">
                    <Field
                        icon={<BiUser className="size-5" />}
                        label={t("login.username", "Nom d'utilisateur")}
                    >
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            autoComplete="username"
                            autoFocus
                            spellCheck={false}
                            className="w-full bg-transparent text-white outline-none"
                        />
                    </Field>
                    <Field
                        icon={<BiLockAlt className="size-5" />}
                        label={t("login.password", "Mot de passe")}
                    >
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="current-password"
                            className="w-full bg-transparent text-white outline-none"
                        />
                    </Field>
                </div>

                {login.error && (
                    <p className="text-red-300 text-sm bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                        {login.error.message}
                    </p>
                )}

                <button
                    type="submit"
                    disabled={login.isPending || !username || !password}
                    className={cn(
                        "w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed",
                        "text-white font-bold py-3 rounded-md transition-colors",
                    )}
                >
                    {login.isPending
                        ? t("login.signing_in", "Connexion…")
                        : t("login.submit", "Se connecter")}
                </button>

                <p className="text-[10px] text-[--muted]/70 text-center leading-relaxed">
                    {t(
                        "login.hint_admin",
                        "Première utilisation ? Le compte admin par défaut est défini via NOTFLIX_ADMIN_USERNAME / NOTFLIX_ADMIN_PASSWORD (défaut : admin / admin).",
                    )}
                </p>
            </form>
        </div>
    )
}

function Field({
    icon,
    label,
    children,
}: {
    icon: React.ReactNode
    label: string
    children: React.ReactNode
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
                <span className="text-[--muted] shrink-0">{icon}</span>
                {children}
            </span>
        </label>
    )
}
