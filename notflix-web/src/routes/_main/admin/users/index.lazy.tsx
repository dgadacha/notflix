import Page from "@/app/(main)/admin/users/page"
import { createLazyFileRoute } from "@tanstack/react-router"

export const Route = createLazyFileRoute("/_main/admin/users/")({
    component: Page,
})
