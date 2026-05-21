/**
 * Mobile-only bottom tab bar — Netflix iOS / TikTok / Instagram pattern.
 *
 * Visible < sm. Hidden on:
 *  - /watch (player is fullscreen)
 *  - /profiles (picker is fullscreen)
 *  - any /auth or /offline route
 *
 * The top nav links (Accueil / Mes listes / Découvrir) are hidden in the same
 * breakpoint over in netflix-top-bar.tsx — only the logo + avatar remain up
 * top on mobile, real navigation happens here.
 */
import { useActiveProfile } from "@/lib/profiles/profiles"
import { SeaLink } from "@/components/shared/sea-link"
import { cn } from "@/components/ui/core/styling"
import { usePathname } from "@/lib/navigation"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { BiUser } from "react-icons/bi"
import { FiSearch } from "react-icons/fi"
// `LuHome` was renamed to `LuHouse` in lucide v0.453+ (react-icons/lu mirror).
import { LuHouse, LuListVideo, LuCompass } from "react-icons/lu"

export function NetflixBottomTab() {
    const { t } = useTranslation()
    const pathname = usePathname()
    const activeProfile = useActiveProfile()

    // Hide where it doesn't belong.
    if (pathname.startsWith("/watch")) return null
    if (pathname.startsWith("/profiles")) return null
    if (pathname.startsWith("/auth")) return null
    if (pathname.startsWith("/offline")) return null

    const items = [
        { href: "/",          label: t("nav.home"),     icon: LuHouse,     active: pathname === "/" },
        { href: "/search",    label: t("nav.search"),   icon: FiSearch,    active: pathname.startsWith("/search") },
        { href: "/lists",     label: t("nav.lists"),    icon: LuListVideo, active: pathname.startsWith("/lists") },
        { href: "/discover",  label: t("nav.discover"), icon: LuCompass,   active: pathname.startsWith("/discover") },
        { href: "/profiles",  label: t("nav.profile"),  icon: BiUser,      active: false /* not a top-level nav state */, isAvatar: true },
    ] as const

    return (
        <nav
            data-netflix-bottom-tab
            aria-label="Mobile navigation"
            className={cn(
                // Mobile only — > sm gets the regular top bar.
                "sm:hidden fixed inset-x-0 bottom-0 z-[55]",
                "bg-black/95 backdrop-blur-md border-t border-white/10",
                // iPhone home-indicator clearance.
                "pb-[max(env(safe-area-inset-bottom),0px)]",
            )}
        >
            <ul className="flex items-stretch justify-around h-14">
                {items.map(item => {
                    const Icon = item.icon
                    return (
                        <li key={item.href} className="flex-1">
                            <SeaLink
                                href={item.href}
                                className={cn(
                                    "h-full flex flex-col items-center justify-center gap-0.5",
                                    "text-[10px] font-medium transition-colors",
                                    item.active
                                        ? "text-white"
                                        : "text-gray-400 hover:text-white",
                                )}
                            >
                                {"isAvatar" in item && item.isAvatar && activeProfile ? (
                                    <span
                                        className="size-6 rounded-md flex items-center justify-center text-sm shadow"
                                        style={{ backgroundColor: activeProfile.color }}
                                        aria-hidden
                                    >
                                        {activeProfile.avatar}
                                    </span>
                                ) : (
                                    <Icon className="text-[22px]" />
                                )}
                                <span>{item.label}</span>
                            </SeaLink>
                        </li>
                    )
                })}
            </ul>
        </nav>
    )
}
