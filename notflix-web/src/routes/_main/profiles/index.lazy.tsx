import Page from "@/app/(main)/profiles/page"
import { createLazyFileRoute } from "@tanstack/react-router"

export const Route = createLazyFileRoute("/_main/profiles/")({
    component: Page,
})
