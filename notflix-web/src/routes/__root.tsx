import { CustomBackgroundImage } from "@/app/(main)/_features/custom-ui/custom-background-image"
import Template from "@/app/template"
import { AppErrorBoundary } from "@/components/shared/app-error-boundary"
import { RouteFallback } from "@/components/shared/loading-overlay-with-logo"
import { NotFound } from "@/components/shared/not-found"

import { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"

import { createStore } from "jotai"
import React from "react"

export const Route = createRootRouteWithContext<{
    queryClient: QueryClient
    store: ReturnType<typeof createStore>
}>()({
    component: () => (
        <Template>
            <CustomBackgroundImage />
            <Outlet />
            {/*<TanStackRouterDevtools />*/}
        </Template>
    ),
    // RouteFallback is a small spinner — does NOT flash the big Notflix
    // logo between pages. pendingMs bumped to 600 so fast transitions
    // (cached chunks, instant React Query reads) render nothing at all.
    pendingComponent: RouteFallback,
    pendingMs: 600,
    errorComponent: AppErrorBoundary,
    notFoundComponent: NotFound,
})
