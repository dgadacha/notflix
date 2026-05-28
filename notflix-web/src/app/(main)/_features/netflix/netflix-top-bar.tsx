/**
 * Notflix top navigation bar — fixed, fades from gradient → solid black on
 * scroll, Netflix-style. Mobile (< sm) shows only the logo + profile chip;
 * the page nav links live in NetflixBottomTab.
 */
import { LanguageSwitcher } from "@/components/shared/language-switcher"
import { SeaLink } from "@/components/shared/sea-link"
import { cn } from "@/components/ui/core/styling"
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { useCurrentUser, useLogout } from "@/lib/auth"
import { usePathname, useRouter } from "@/lib/navigation"
import { useActiveProfile, useProfileActions } from "@/lib/profiles/profiles"
import { useQuery } from "@tanstack/react-query"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiLogOut, BiShield, BiUser } from "react-icons/bi"
import { FiSearch } from "react-icons/fi"
import { LuSettings, LuUsers } from "react-icons/lu"

const SCROLL_THRESHOLD = 60

export function NetflixTopBar() {
    const { t } = useTranslation()
    const pathname = usePathname()

    const [scrolled, setScrolled] = React.useState(false)

    React.useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD)
        onScroll()
        window.addEventListener("scroll", onScroll, { passive: true })
        return () => window.removeEventListener("scroll", onScroll)
    }, [])

    const navItems: { name: string; href: string; isCurrent: boolean }[] = [
        { name: t("nav.home", "Accueil"), href: "/", isCurrent: pathname === "/" },
        { name: t("nav.categories", "Catégories"), href: "/categories", isCurrent: pathname.startsWith("/categories") },
        { name: t("nav.lists", "Mes listes"), href: "/lists", isCurrent: pathname.startsWith("/lists") },
    ]

    // Player route is fullscreen — no chrome.
    if (pathname.startsWith("/watch")) return null

    return (
        <header
            data-netflix-top-bar
            className={cn(
                "fixed top-0 inset-x-0 z-[60] transition-colors duration-300",
                scrolled ? "bg-black/95 backdrop-blur-sm" : "bg-gradient-to-b from-black/70 via-black/40 to-transparent",
                // iPhone notch / Dynamic Island clearance.
                "pt-[max(env(safe-area-inset-top),0px)]",
            )}
        >
            <div className="flex items-center h-16 lg:h-[68px] px-3 sm:px-6 lg:px-12 gap-2 sm:gap-4 lg:gap-10">
                <SeaLink href="/" className="flex items-center shrink-0" aria-label="Notflix">
                    {/* Wordmark texte rendu en Bebas Neue — condensé,
                        tout-en-capitales par construction (Bebas n'a
                        qu'un seul jeu de glyphes). Pas d'asset image,
                        scale net en rétine, taille modérée pour rester
                        dans l'esprit "discret" de la navbar. */}
                    <span
                        className="tracking-wide text-brand-500 text-2xl sm:text-[26px] lg:text-[28px] leading-none select-none"
                        style={{ fontFamily: '"Bebas Neue", "Impact", sans-serif' }}
                    >
                        NOTFLIX
                    </span>
                </SeaLink>

                {/* Nav links hidden < sm — the bottom tab bar takes over. */}
                <nav className="hidden sm:flex items-center gap-0.5 sm:gap-1 lg:gap-2 min-w-0">
                    {navItems.map(item => (
                        <SeaLink
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "px-2 lg:px-3 py-2 text-[13px] sm:text-sm lg:text-[15px] font-medium rounded-md transition-colors whitespace-nowrap",
                                item.isCurrent
                                    ? "text-white"
                                    : "text-gray-300 hover:text-white",
                            )}
                        >
                            {item.name}
                        </SeaLink>
                    ))}
                </nav>

                <div className="flex-1" />

                {/* Search icon hidden < sm — search lives in the bottom tab. */}
                <SeaLink
                    href="/search"
                    aria-label={t("common.search", "Rechercher")}
                    className={cn(
                        "hidden sm:inline-flex p-2 rounded-full text-gray-300 hover:text-white hover:bg-white/10 transition-colors shrink-0",
                        pathname.startsWith("/search") && "text-white bg-white/10",
                    )}
                >
                    <FiSearch className="size-5" />
                </SeaLink>

                <TorBoxBadge />

                <ProfileDropdown />
            </div>
        </header>
    )
}

// ---------------------------------------------------------------------------
// TorBox status badge
// ---------------------------------------------------------------------------

type TorBoxStatus = {
    configured: boolean
    email?: string
    plan?: number
    planName?: string
    isSubscribed?: boolean
    premiumExpiresAt?: string
    totalDownloaded?: number
    cooldownUntil?: string
}

function useTorBoxStatus() {
    return useQuery<TorBoxStatus>({
        queryKey: ["torbox", "status"],
        queryFn: async () => {
            const r = await fetch("/api/v1/torbox/status")
            if (!r.ok) throw new Error(`torbox ${r.status}`)
            const j = await r.json()
            return (j.data ?? j) as TorBoxStatus
        },
        refetchInterval: 5 * 60_000, // 5 min — plan / expiry barely changes
        staleTime: 60_000,
    })
}

function formatBytes(n: number): string {
    if (!n || n < 0) return ""
    const units = ["B", "KB", "MB", "GB", "TB"]
    let v = n, u = 0
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024
        u++
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`
}

function daysUntil(iso?: string): number | null {
    if (!iso) return null
    const t = Date.parse(iso)
    if (isNaN(t)) return null
    return Math.floor((t - Date.now()) / 86_400_000)
}

function TorBoxBadge() {
    const router = useRouter()
    const { t } = useTranslation()
    const { data, isLoading } = useTorBoxStatus()

    if (isLoading || !data || !data.configured) return null

    const cooldownActive = data.cooldownUntil
        ? Date.parse(data.cooldownUntil) > Date.now()
        : false
    const days = daysUntil(data.premiumExpiresAt)
    const expiringSoon = data.isSubscribed && days !== null && days >= 0 && days < 7
    const expired = data.isSubscribed === false || (days !== null && days < 0)

    const status: "ok" | "warn" | "down" = cooldownActive || expired
        ? "down"
        : expiringSoon
            ? "warn"
            : "ok"

    const dotColor = status === "down" ? "bg-red-400" : status === "warn" ? "bg-amber-400" : "bg-emerald-400"

    const tooltipParts: string[] = []
    if (data.planName) tooltipParts.push(data.planName)
    if (days !== null) {
        if (days < 0) tooltipParts.push(t("nav.torbox_expired", "expiré"))
        else tooltipParts.push(t("nav.torbox_days_left", "{{n}} j restants", { n: days }))
    }
    if (cooldownActive) tooltipParts.push(t("nav.torbox_cooldown", "rate-limit actif"))
    if (data.totalDownloaded && data.totalDownloaded > 0) {
        tooltipParts.push(t("nav.torbox_total_downloaded", "{{x}} téléchargés", { x: formatBytes(data.totalDownloaded) }))
    }

    return (
        <button
            type="button"
            onClick={() => router.push("/settings")}
            title={tooltipParts.join(" · ")}
            className={cn(
                "hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full",
                "bg-white/5 hover:bg-white/10 border border-white/10 transition-colors shrink-0",
                "text-[11px] font-semibold text-white/90",
            )}
            aria-label="TorBox status"
        >
            <span className={cn("size-1.5 rounded-full", dotColor)} />
            <span className="hidden lg:inline">TorBox</span>
            {data.planName && (
                <span className="hidden lg:inline text-white/60">· {data.planName}</span>
            )}
        </button>
    )
}

function ProfileDropdown() {
    const { t } = useTranslation()
    const router = useRouter()
    const activeProfile = useActiveProfile()
    const { profiles, select } = useProfileActions()
    const { data: user } = useCurrentUser()
    const logout = useLogout()

    const onSwitchProfile = () => {
        select(null)
        router.push("/profiles")
    }
    const onManageProfiles = () => router.push("/profiles")

    return (
        <DropdownMenu
            trigger={
                <button
                    type="button"
                    aria-label="Profile menu"
                    className="flex items-center gap-2 rounded-full p-1 hover:bg-white/10 transition-colors"
                >
                    {activeProfile ? (
                        <span
                            className="size-8 rounded-md flex items-center justify-center text-lg shadow-md"
                            style={{ backgroundColor: activeProfile.color }}
                            aria-hidden
                        >
                            {activeProfile.avatar}
                        </span>
                    ) : (
                        <span className="size-8 rounded-md flex items-center justify-center bg-white/10 text-white">
                            <BiUser />
                        </span>
                    )}
                </button>
            }
        >
            {!!user && (
                <div className="px-2 py-1.5 text-xs text-[--muted] truncate max-w-[14rem]">
                    <span className="text-white font-semibold">{user.displayName || user.username}</span>
                    {user.isAdmin && (
                        <span className="ml-2 text-[9px] uppercase tracking-wider text-brand-300 font-bold">
                            admin
                        </span>
                    )}
                </div>
            )}
            {!!activeProfile && (
                <div className="px-2 py-1.5 text-xs text-[--muted] truncate max-w-[14rem]">
                    {activeProfile.avatar}  {activeProfile.name}
                </div>
            )}

            <div className="px-2 py-1.5 flex items-center justify-between gap-3">
                <span className="text-xs text-[--muted]">{t("common.language", "Langue")}</span>
                <LanguageSwitcher />
            </div>

            <DropdownMenuSeparator />

            {profiles.length > 0 && activeProfile && (
                <DropdownMenuItem onClick={onSwitchProfile}>
                    <LuUsers /> {t("profiles.switch", "Changer de profil")}
                </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onManageProfiles}>
                <BiUser /> {profiles.length === 0 ? t("profiles.enable", "Activer les profils") : t("profiles.manage", "Gérer les profils")}
            </DropdownMenuItem>

            {user?.isAdmin && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => router.push("/admin/users")}>
                        <BiShield /> {t("nav.admin_users", "Comptes utilisateurs")}
                    </DropdownMenuItem>
                </>
            )}

            <DropdownMenuSeparator />

            <DropdownMenuItem onClick={() => router.push("/settings")}>
                <LuSettings /> {t("nav.settings", "Paramètres")}
            </DropdownMenuItem>

            <DropdownMenuItem onClick={() => logout.mutate()}>
                <BiLogOut /> {t("nav.logout", "Déconnexion")}
            </DropdownMenuItem>
        </DropdownMenu>
    )
}
