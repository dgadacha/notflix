import { NetflixHome } from "@/app/(main)/_features/netflix/netflix-home"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_main/")({
    component: NetflixHome,
})
