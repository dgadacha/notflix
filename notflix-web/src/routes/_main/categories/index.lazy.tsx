import Page from "@/app/(main)/categories/page"
import { createLazyFileRoute } from "@tanstack/react-router"

export const Route = createLazyFileRoute("/_main/categories/")({
    component: Page,
})
