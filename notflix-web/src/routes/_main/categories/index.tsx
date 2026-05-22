import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

const searchSchema = z.object({
    type: z.enum(["movie", "tv"]).optional(),
    genre: z.coerce.number().optional(),
})

export const Route = createFileRoute("/_main/categories/")({
    validateSearch: searchSchema,
})
