import Page from "@/app/(main)/watch/page"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/_main/watch/")({
    component: Page,
})
