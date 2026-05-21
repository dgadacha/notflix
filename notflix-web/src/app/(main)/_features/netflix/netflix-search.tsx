import { AL_BaseAnime } from "@/api/generated/types"
import { useAnilistListAnime } from "@/api/hooks/anilist.hooks"
import { NetflixCard } from "@/app/(main)/_features/netflix/netflix-card"
import { Skeleton } from "@/components/ui/skeleton"
import { TextInput } from "@/components/ui/text-input"
import { useDebounce } from "@/hooks/use-debounce"
import React from "react"
import { useTranslation } from "react-i18next"
import { FiSearch } from "react-icons/fi"

export function NetflixSearch() {
    const { t } = useTranslation()
    const [input, setInput] = React.useState("")
    const debounced = useDebounce(input.trim(), 350)

    const enabled = debounced.length >= 2

    const { data, isFetching } = useAnilistListAnime(
        {
            search: debounced,
            page: 1,
            perPage: 36,
            sort: ["SEARCH_MATCH"],
            status: ["FINISHED", "RELEASING", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"],
        },
        enabled,
    )

    const media = (data?.Page?.media ?? []).filter((m): m is AL_BaseAnime => !!m)

    return (
        <div className="px-4 sm:px-6 lg:px-16 py-6 lg:py-8 space-y-8 lg:space-y-10">
            <div className="max-w-3xl mx-auto space-y-4 lg:space-y-5 text-center">
                <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight">
                    {t("search.title")}
                </h1>
                <TextInput
                    autoFocus
                    size="lg"
                    placeholder={t("search.placeholder")}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    leftIcon={<FiSearch className="size-5" />}
                    className="!h-14 !text-base bg-white/5 border-white/10 !text-white placeholder:text-[--muted] rounded-full !pl-14 !pr-6"
                />
            </div>

            {!enabled && (
                <p className="text-center text-[--muted] py-12">
                    {t("search.start_typing")}
                </p>
            )}

            {enabled && isFetching && media.length === 0 && (
                <ResultGrid>
                    {Array.from({ length: 12 }).map((_, i) => (
                        <Skeleton key={i} className="w-full aspect-video rounded-md" />
                    ))}
                </ResultGrid>
            )}

            {enabled && !isFetching && media.length === 0 && (
                <p className="text-center text-[--muted] py-12">
                    {t("search.no_results")}
                </p>
            )}

            {media.length > 0 && (
                <ResultGrid>
                    {media.map(m => <NetflixCard key={m.id} media={m} variant="grid" />)}
                </ResultGrid>
            )}
        </div>
    )
}

/** Grid with vertical breathing room so card hover-scale doesn't crash into rows above/below. */
function ResultGrid({ children }: { children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-x-4 gap-y-6 py-2">
            {children}
        </div>
    )
}
