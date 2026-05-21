import { AL_BaseAnime } from "@/api/generated/types"
import { useAnilistListAnime } from "@/api/hooks/anilist.hooks"
import { useMediaPreviewModal } from "@/app/(main)/_features/media/_containers/media-preview-modal"
import { SeaImage } from "@/components/shared/sea-image"
import { CommandGroup, CommandItem } from "@/components/ui/command"
import { LoadingSpinner } from "@/components/ui/loading-spinner"
import { useDebounce } from "@/hooks/use-debounce"
import { useRouter } from "@/lib/navigation"
import { atom } from "jotai"
import { useAtom } from "jotai/react"
import React from "react"
import { CommandHelperText, CommandItemMedia } from "./_components/command-utils"
import { useSeaCommandContext } from "./sea-command"

const selectMediaActionAtom = atom<"anime" | null>(null)
const selectedAnimeAtom = atom<AL_BaseAnime | null>(null)

export function useSeaCommandSearchSelectMedia() {
    const [, setSelectMediaAction] = useAtom(selectMediaActionAtom)
    const [selectedAnime, setSelectedAnime] = useAtom(selectedAnimeAtom)

    return {
        searchAndSelectMedia: (type: "anime") => {
            setSelectMediaAction(type)
        },
        selectedAnime,
        onAcknowledgeSelection: () => {
            setSelectMediaAction(null)
            setSelectedAnime(null)
        },
    }
}

export function SeaCommandSearch() {
    useMediaPreviewModal() // keep modal subscription parity with prior behavior

    const [selectMediaAction] = useAtom(selectMediaActionAtom)
    const [, setSelectedAnime] = useAtom(selectedAnimeAtom)

    const { input, select, scrollToTop, command: { args } } = useSeaCommandContext()

    const router = useRouter()

    const animeSearchInput = args.join(" ")
    const debouncedQuery = useDebounce(animeSearchInput, 500)

    const { data: animeData, isLoading, isFetching } = useAnilistListAnime({
        search: debouncedQuery,
        page: 1,
        perPage: 10,
        status: ["FINISHED", "CANCELLED", "NOT_YET_RELEASED", "RELEASING"],
        sort: ["SEARCH_MATCH"],
    }, debouncedQuery.length > 0)

    const media = React.useMemo(() => animeData?.Page?.media?.filter(Boolean), [animeData])

    React.useEffect(() => {
        const cl = scrollToTop()
        return () => cl()
    }, [input, isLoading, isFetching])

    React.useEffect(() => {
        if (!selectMediaAction) {
            setSelectedAnime(null)
        }
    }, [selectMediaAction])

    return (
        <>
            {animeSearchInput === "" ? (
                <CommandHelperText
                    command="/search [title]"
                    description="Search anime"
                    show={true}
                />
            ) : (
                <CommandGroup heading="Anime results">
                    {(debouncedQuery !== "" && (!media || media.length === 0) && (isLoading || isFetching)) && (
                        <LoadingSpinner />
                    )}
                    {debouncedQuery !== "" && !isLoading && !isFetching && (!media || media.length === 0) && (
                        <div className="py-14 px-6 text-center text-sm sm:px-14">
                            <div className="h-[10rem] w-[10rem] mx-auto flex-none rounded-[--radius-md] object-cover object-center relative overflow-hidden">
                                <SeaImage
                                    src="/luffy-01.png"
                                    alt=""
                                    fill
                                    quality={100}
                                    priority
                                    sizes="10rem"
                                    className="object-contain object-top"
                                />
                            </div>
                            <h5 className="mt-4 font-semibold text-[--foreground]">Nothing found</h5>
                            <p className="mt-2 text-[--muted]">
                                We couldn't find anything with that name. Please try again.
                            </p>
                        </div>
                    )}
                    {media?.map(item => (
                        <CommandItem
                            key={item?.id || ""}
                            onSelect={() => {
                                select(() => {
                                    if (selectMediaAction === "anime") {
                                        setSelectedAnime(item)
                                    } else {
                                        router.push(`/entry?id=${item.id}`)
                                    }
                                })
                            }}
                        >
                            <CommandItemMedia media={item} type="anime" />
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}
        </>
    )
}
