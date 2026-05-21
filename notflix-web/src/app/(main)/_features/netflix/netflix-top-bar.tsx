import { useRefreshAnimeCollection } from "@/api/hooks/anilist.hooks"
import { useLogout } from "@/api/hooks/auth.hooks"
import { isLoginModalOpenAtom } from "@/app/(main)/_atoms/server-status.atoms"
import { useCurrentUser, useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { ConfirmationDialog, useConfirmationDialog } from "@/components/shared/confirmation-dialog"
import { LanguageSwitcher } from "@/components/shared/language-switcher"
import { SeaLink } from "@/components/shared/sea-link"
import { Avatar } from "@/components/ui/avatar"
import { cn } from "@/components/ui/core/styling"
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { usePathname, useRouter } from "@/lib/navigation"
import { useActiveProfile, useProfileActions } from "@/lib/profiles/profiles"
import { useAtom } from "jotai"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiLogIn, BiLogOut, BiUser } from "react-icons/bi"
import { FiSearch } from "react-icons/fi"
import { HiOutlineServerStack } from "react-icons/hi2"
import { IoCloudOfflineOutline } from "react-icons/io5"
import { LuRefreshCw, LuSettings, LuUsers } from "react-icons/lu"
import { MdOutlineConnectWithoutContact } from "react-icons/md"
import { TbPuzzle } from "react-icons/tb"
import { nakamaModalOpenAtom } from "../nakama/nakama-manager"

const SCROLL_THRESHOLD = 60

export function NetflixTopBar() {
    const { t } = useTranslation()
    const pathname = usePathname()
    const router = useRouter()
    const serverStatus = useServerStatus()

    const [scrolled, setScrolled] = React.useState(false)

    React.useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD)
        onScroll()
        window.addEventListener("scroll", onScroll, { passive: true })
        return () => window.removeEventListener("scroll", onScroll)
    }, [])

    const navItems: { name: string; href: string; isCurrent: boolean }[] = [
        { name: t("nav.home"), href: "/", isCurrent: pathname === "/" },
        { name: t("nav.lists"), href: "/lists", isCurrent: pathname.startsWith("/lists") },
        { name: t("nav.discover"), href: "/discover", isCurrent: pathname.startsWith("/discover") },
    ]

    // Player route is fullscreen — no chrome.
    if (pathname.startsWith("/watch")) return null
    if (serverStatus?.isOffline) return null

    return (
        <header
            data-netflix-top-bar
            className={cn(
                "fixed top-0 inset-x-0 z-[60] transition-colors duration-300",
                scrolled ? "bg-black/95 backdrop-blur-sm" : "bg-gradient-to-b from-black/70 via-black/40 to-transparent",
                // iPhone notch / Dynamic Island clearance.
                "pt-[max(env(safe-area-inset-top),0px)]",
            )}
            style={{ WebkitAppRegion: "drag" } as any}
        >
            <div
                className="flex items-center h-16 lg:h-[68px] px-3 sm:px-6 lg:px-12 gap-2 sm:gap-4 lg:gap-10"
                style={{ WebkitAppRegion: "no-drag" } as any}
            >
                <SeaLink href="/" className="flex items-center gap-2 shrink-0">
                    <img src="/notflix-logo.svg" alt="Notflix" className="size-8 lg:size-9" />
                    <span className="hidden sm:inline text-lg lg:text-xl font-extrabold text-white tracking-tight">NOTFLIX</span>
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

                {/* Search icon also hidden < sm — search lives in the bottom tab. */}
                <SeaLink
                    href="/search"
                    aria-label={t("common.search")}
                    className={cn(
                        "hidden sm:inline-flex p-2 rounded-full text-gray-300 hover:text-white hover:bg-white/10 transition-colors shrink-0",
                        pathname.startsWith("/search") && "text-white bg-white/10",
                    )}
                >
                    <FiSearch className="size-5" />
                </SeaLink>

                <ProfileDropdown />
            </div>
        </header>
    )
}

function ProfileDropdown() {
    const { t } = useTranslation()
    const router = useRouter()
    const user = useCurrentUser()
    const serverStatus = useServerStatus()
    const { mutate: logout } = useLogout()
    const { mutate: refreshAC, isPending: refreshing } = useRefreshAnimeCollection()
    const [, setNakamaModalOpen] = useAtom(nakamaModalOpenAtom)
    const [, setLoginModal] = useAtom(isLoginModalOpenAtom)

    const activeProfile = useActiveProfile()
    const { profiles, select } = useProfileActions()

    const confirmSignOut = useConfirmationDialog({
        title: t("nav.sign_out"),
        description: "Are you sure?",
        onConfirm: () => logout(),
    })

    const avatarSrc = user?.viewer?.avatar?.medium || undefined
    const displayName = activeProfile?.name || user?.viewer?.name || (user?.isSimulated ? t("nav.sign_in") : "")

    // Switch profile = drop the active selection then bounce to /profiles. The
    // gate in MainLayout would do this anyway but the explicit push gives an
    // instant transition with no flash of the previous page.
    const onSwitchProfile = () => {
        select(null)
        router.push("/profiles")
    }

    const onManageProfiles = () => router.push("/profiles")

    return (
        <>
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
                            <Avatar size="sm" src={avatarSrc} className="size-8" />
                        )}
                    </button>
                }
            >
                {!!displayName && (
                    <div className="px-2 py-1.5 text-xs text-[--muted] truncate max-w-[14rem]">
                        {activeProfile ? `${activeProfile.avatar}  ${activeProfile.name}` : displayName}
                    </div>
                )}

                <div className="px-2 py-1.5 flex items-center justify-between gap-3">
                    <span className="text-xs text-[--muted]">{t("common.language")}</span>
                    <LanguageSwitcher />
                </div>

                <DropdownMenuSeparator />

                {profiles.length > 0 && activeProfile && (
                    <DropdownMenuItem onClick={onSwitchProfile}>
                        <LuUsers /> {t("profiles.switch")}
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onManageProfiles}>
                    <BiUser /> {profiles.length === 0 ? t("profiles.enable") : t("profiles.manage")}
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem onClick={() => router.push("/settings")}>
                    <LuSettings /> {t("nav.settings")}
                </DropdownMenuItem>

                <DropdownMenuItem onClick={() => router.push("/extensions")}>
                    <TbPuzzle /> {t("nav.extensions")}
                </DropdownMenuItem>

                {(serverStatus?.debridSettings?.enabled && !!serverStatus?.debridSettings?.provider) && (
                    <DropdownMenuItem onClick={() => router.push("/debrid")}>
                        <HiOutlineServerStack /> {t("nav.debrid")}
                    </DropdownMenuItem>
                )}

                {serverStatus?.settings?.nakama?.enabled && (
                    <DropdownMenuItem onClick={() => setNakamaModalOpen(true)}>
                        <MdOutlineConnectWithoutContact /> {t("nav.nakama")}
                    </DropdownMenuItem>
                )}

                <DropdownMenuItem onClick={() => router.push("/offline")}>
                    <IoCloudOfflineOutline /> {t("nav.offline")}
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem onClick={() => !refreshing && refreshAC()}>
                    <LuRefreshCw className={cn(refreshing && "animate-spin")} /> {t("nav.refresh_anilist")}
                </DropdownMenuItem>

                {user?.isSimulated ? (
                    <DropdownMenuItem onClick={() => setLoginModal(true)}>
                        <BiLogIn /> {t("nav.sign_in")}
                    </DropdownMenuItem>
                ) : (
                    <DropdownMenuItem onClick={confirmSignOut.open}>
                        <BiLogOut /> {t("nav.sign_out")}
                    </DropdownMenuItem>
                )}
            </DropdownMenu>

            <ConfirmationDialog {...confirmSignOut} />
        </>
    )
}
