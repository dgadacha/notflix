import { AL_BaseAnime } from "@/api/generated/types"
import { NetflixCard } from "@/app/(main)/_features/netflix/netflix-card"
import { ROW } from "@/app/(main)/_features/netflix/netflix.constants"
import { cn } from "@/components/ui/core/styling"
import { Skeleton } from "@/components/ui/skeleton"
import React from "react"

type Props = {
    title: string
    media: ReadonlyArray<AL_BaseAnime | null | undefined> | undefined
    isLoading?: boolean
    /** Forwarded to the section root for in-view lazy data hooks. */
    rootRef?: React.Ref<HTMLDivElement>
    /** Mark first row above the fold so its images load eagerly. */
    priorityImages?: boolean
}

export function NetflixRow({ title, media, isLoading, rootRef, priorityImages }: Props) {
    const items = React.useMemo(
        () => (media ?? []).filter((m): m is AL_BaseAnime => !!m),
        [media],
    )

    if (!isLoading && items.length === 0) return null

    return (
        <NetflixRowShell title={title} rootRef={rootRef}>
            {isLoading
                ? Array.from({ length: ROW.skeletonCount }).map((_, i) => (
                    <Skeleton
                        key={i}
                        className={cn("flex-none aspect-video rounded-md", ROW.cardWidthClass)}
                    />
                ))
                : items.map(m => <NetflixCard key={m.id} media={m} priority={priorityImages} />)}
        </NetflixRowShell>
    )
}

/**
 * Shared layout for any horizontally-scrolling Netflix row.
 *
 * Title and scroller share the SAME px constant so the leftmost card always sits
 * directly under the title. `scroll-pl-*` mirrors the padding into the snap
 * scroll-area so a programmatic scroll snaps cleanly to the title's edge.
 */
export function NetflixRowShell({
    title,
    children,
    rootRef,
}: {
    title: string
    children: React.ReactNode
    rootRef?: React.Ref<HTMLDivElement>
}) {
    return (
        <section ref={rootRef} className="space-y-3">
            <h2 className={cn("text-xl lg:text-2xl font-bold text-white tracking-tight", ROW.paddingX)}>
                {title}
            </h2>
            <div
                className={cn(
                    "flex gap-2 overflow-x-auto scrollbar-hide snap-x snap-mandatory",
                    "scroll-pl-6 lg:scroll-pl-16",
                    ROW.paddingX,
                    ROW.scrollPaddingY,
                )}
            >
                {children}
            </div>
        </section>
    )
}
