import { NetflixHome } from "@/app/(main)/_features/netflix/netflix-home"
import { MediaEntryPageLoadingDisplay } from "@/app/(main)/_features/media/_components/media-entry-page-loading-display"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_main/")({
    component: NetflixHome,
    pendingComponent: MediaEntryPageLoadingDisplay,
    pendingMs: 250,
})
