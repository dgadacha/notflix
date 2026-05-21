import { MainLayout } from "@/app/(main)/_features/layout/main-layout"
import { OfflineLayout } from "@/app/(main)/_features/layout/offline-layout"
import { TourOverlay } from "@/app/(main)/_features/tour/tour-overlay"
import { useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { ServerDataWrapper } from "@/app/(main)/server-data-wrapper"
import { AppErrorBoundary } from "@/components/shared/app-error-boundary"
import { createFileRoute, Outlet } from "@tanstack/react-router"
import React from "react"
import { ErrorBoundary } from "react-error-boundary"

export const Route = createFileRoute("/_main")({
    component: Layout,
})

function Layout() {
    const serverStatus = useServerStatus()
    const [host, setHost] = React.useState<string>("")

    React.useEffect(() => {
        setHost(window?.location?.host || "")
    }, [])

    if (serverStatus?.isOffline) {
        return (
            <ServerDataWrapper host={host}>
                <OfflineLayout>
                    <div data-offline-layout-container className="h-auto">
                        <div data-offline-layout-content>
                            <Outlet />
                        </div>
                    </div>
                </OfflineLayout>
            </ServerDataWrapper>
        )
    }

    return (
        <ServerDataWrapper host={host}>
            <MainLayout>
                <div data-main-layout-container className="h-auto">
                    {/* Push content under the fixed top bar (top-side) AND clear
                        the mobile bottom tab (~3.5rem + iOS home indicator).
                        Hero pages opt out of the top offset via -mt-16. */}
                    <div data-main-layout-content className="pt-16 lg:pt-[68px] pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0">
                        <ErrorBoundary FallbackComponent={AppErrorBoundary}>
                            <Outlet />
                        </ErrorBoundary>
                    </div>
                </div>
            </MainLayout>
            <TourOverlay />
        </ServerDataWrapper>
    )
}
