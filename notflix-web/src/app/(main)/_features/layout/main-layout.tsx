/**
 * Notflix main layout — the chrome wrapping every authenticated page.
 *
 * Renders:
 *  - Top navbar (Netflix-style; fades on scroll)
 *  - Page content (Outlet via children)
 *  - Mobile bottom tab bar
 *  - Floating detail modal (opens on card click)
 *  - Profile gate (redirects to /profiles when the user has profiles but none active)
 *
 * Intentionally MUCH lighter than the Seanime original: no Nakama, no
 * playlists, no scanner/progress tracking, no native player, no plugin
 * manager. Notflix doesn't have any of those domains.
 */
import { NetflixBottomTab } from "@/app/(main)/_features/netflix/netflix-bottom-tab"
import { NetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { NetflixLogin } from "@/app/(main)/_features/netflix/netflix-login"
import { NetflixPersonModal } from "@/app/(main)/_features/netflix/netflix-person-modal"
import { NetflixTopBar } from "@/app/(main)/_features/netflix/netflix-top-bar"
import { useLocalLibraryEvents } from "@/app/(main)/_features/netflix/use-local-library-events"
import { RouteFallback } from "@/components/shared/loading-overlay-with-logo"
import { AppLayout, AppLayoutContent, AppSidebarProvider } from "@/components/ui/app-layout"
import { useCurrentUser } from "@/lib/auth"
import { usePathname, useRouter } from "@/lib/navigation"
import { activeProfileIdAtom, useProfilesQuery } from "@/lib/profiles/profiles"
import { useAtomValue } from "jotai"
import React from "react"

export const MainLayout = ({ children }: { children: React.ReactNode }) => {
    const { data: user, isLoading } = useCurrentUser()

    // Three-state gate. The login screen is *not* a separate route, so
    // deep links (`/lists`, `/watch?id=…`) survive the auth round trip —
    // the user lands back on the URL they wanted once `useCurrentUser`
    // resolves to a real account.
    //
    // Loading state is a discreet spinner — NOT the big "N" logo
    // splash. That splash fired on every window refocus / network
    // blip (because useCurrentUser refetches), which the user
    // experienced as "le gros N qui apparaît des fois". The thin
    // spinner has the same affordance ("we're working") without
    // hijacking the screen each time.
    if (isLoading) return <RouteFallback />
    if (!user) return <NetflixLogin />

    return <AuthenticatedShell>{children}</AuthenticatedShell>
}

// Hooks below are only mounted when an authenticated user is present —
// keeps the hook order stable across renders and avoids firing the
// profile-gate logic on the public login screen.
function AuthenticatedShell({ children }: { children: React.ReactNode }) {
    useProfileGate()
    // Listen for "a new file landed in your library" SSE pushes from
    // the backend's fsnotify watcher. Fires a toast + invalidates the
    // home rail / settings counters when an event arrives. No-op for
    // unauthenticated users (the inner hook bails out).
    useLocalLibraryEvents()

    return (
        <>
            <NetflixDetailModal />
            {/* Person modal — opened from a cast member click inside the
                detail modal. Sits one z-layer above DetailModal so a
                second click on a cast card in the filmography pushes
                back through both seamlessly. */}
            <NetflixPersonModal />

            <AppSidebarProvider>
                <NetflixTopBar />
                <AppLayout>
                    <AppLayoutContent>
                        {children}
                    </AppLayoutContent>
                </AppLayout>
                <NetflixBottomTab />
            </AppSidebarProvider>
        </>
    )
}

/**
 * Netflix-style profile gate.
 *
 *   - 0 profiles:  no gating (single-user mode preserved)
 *   - 1+ profiles, none selected:  redirect to /profiles to force a pick
 *   - 1+ profiles, valid one selected:  pass through
 *
 * /watch is exempt (so opening a stream in a new tab doesn't bounce the user
 * into the picker), and /profiles itself is exempt to avoid a redirect loop.
 */
function useProfileGate() {
    const { profiles, isFetched } = useProfilesQuery()
    const activeId = useAtomValue(activeProfileIdAtom)
    const router = useRouter()
    const pathname = usePathname()

    React.useEffect(() => {
        if (pathname === "/profiles" || pathname.startsWith("/profiles/")) return
        if (pathname.startsWith("/watch")) return
        if (pathname.startsWith("/auth")) return
        if (pathname.startsWith("/offline")) return

        if (!isFetched) return
        if (profiles.length === 0) return

        const valid = !!activeId && profiles.some(p => p.uid === activeId)
        if (!valid) router.push("/profiles")
    }, [pathname, profiles, activeId, isFetched])
}
