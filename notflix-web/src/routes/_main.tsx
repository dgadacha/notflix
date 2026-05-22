import { MainLayout } from "@/app/(main)/_features/layout/main-layout"
import { AppErrorBoundary } from "@/components/shared/app-error-boundary"
import { createFileRoute, Outlet } from "@tanstack/react-router"
import React from "react"
import { ErrorBoundary } from "react-error-boundary"

export const Route = createFileRoute("/_main")({
    component: Layout,
})

function Layout() {
    return (
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
    )
}
