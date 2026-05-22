/**
 * Person modal — opens when the user clicks a cast member in the
 * detail modal. Shows the actor's bio + their combined filmography
 * (cast credits across movies + TV).
 *
 * Click a filmography card → close this modal + open the regular
 * NetflixDetailModal for that title. The two modals share an atom-based
 * "stack" so navigating Cast → Person → Filmography → Cast → Person
 * stays sane.
 */
import { useNetflixDetailModal } from "@/app/(main)/_features/netflix/netflix-detail-modal"
import { Modal } from "@/components/ui/modal"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/components/ui/core/styling"
import { IconButton } from "@/components/ui/button"
import {
    TMDBPersonCredit,
    tmdbImage,
    useTMDBPerson,
} from "@/lib/tmdb"
import { atom, useAtom } from "jotai"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiX } from "react-icons/bi"

const __personModalAtom = atom<number | null>(null)

export function useNetflixPersonModal() {
    const [, setId] = useAtom(__personModalAtom)
    return {
        openPerson: (id: number) => setId(id),
        closePerson: () => setId(null),
    }
}

export function NetflixPersonModal() {
    const [personId, setPersonId] = useAtom(__personModalAtom)
    const open = personId !== null

    return (
        <Modal
            open={open}
            onOpenChange={(v) => { if (!v) setPersonId(null) }}
            overlayClass="!z-[75]"
            contentClass="!max-w-4xl !p-0 !rounded-xl overflow-hidden bg-[#0a0a0a] border-white/5"
            hideCloseButton
        >
            {open && (
                <>
                    <IconButton
                        intent="gray-subtle"
                        size="md"
                        className={cn(
                            "absolute z-[85] rounded-full bg-black/80 hover:bg-black !text-white",
                            "right-3 top-3 size-10",
                        )}
                        icon={<BiX className="text-2xl" />}
                        onClick={() => setPersonId(null)}
                        aria-label="Close"
                    />
                    <PersonBody personId={personId!} />
                </>
            )}
        </Modal>
    )
}

function PersonBody({ personId }: { personId: number }) {
    const { t } = useTranslation()
    const { data, isLoading } = useTMDBPerson(personId)
    const { openDetail } = useNetflixDetailModal()
    const { closePerson } = useNetflixPersonModal()

    if (isLoading || !data) return <BodySkeleton />

    const photo = tmdbImage("w300", data.profile_path)
    // Filter + de-dupe by id, sort by popularity (most-known first),
    // truncate at 24 — anything more is overwhelming in a modal.
    const credits = React.useMemo(() => {
        const raw = data.combined_credits?.cast ?? []
        const seen = new Set<number>()
        const deduped: TMDBPersonCredit[] = []
        for (const c of raw) {
            if (seen.has(c.id)) continue
            seen.add(c.id)
            deduped.push(c)
        }
        deduped.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
        return deduped.slice(0, 24)
    }, [data])

    const onPickCredit = (c: TMDBPersonCredit) => {
        closePerson()
        // Tiny defer so the underlying modal opens after this one
        // closes; otherwise the second modal can lose focus to the
        // closing one.
        window.setTimeout(() => openDetail(c.id, c.media_type), 50)
    }

    return (
        <div className="p-5 sm:p-6 lg:p-8 space-y-6 max-h-[90vh] overflow-y-auto">
            <header className="flex gap-4 sm:gap-6">
                {photo ? (
                    <img
                        src={photo}
                        alt={data.name}
                        className="size-24 sm:size-28 lg:size-32 rounded-md object-cover shrink-0 bg-white/5"
                    />
                ) : (
                    <div className="size-24 sm:size-28 lg:size-32 rounded-md bg-white/5 border border-white/10 shrink-0" />
                )}
                <div className="flex-1 min-w-0 space-y-1">
                    <h2 className="text-xl sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
                        {data.name}
                    </h2>
                    {data.known_for_department && (
                        <p className="text-[--muted] text-sm">{data.known_for_department}</p>
                    )}
                    <div className="text-[--muted] text-xs space-y-0.5">
                        {data.birthday && (
                            <p>
                                {t("person.born", "Né(e) le")} {data.birthday}
                                {data.place_of_birth && ` · ${data.place_of_birth}`}
                            </p>
                        )}
                        {data.deathday && (
                            <p>{t("person.died", "Décédé(e) le")} {data.deathday}</p>
                        )}
                    </div>
                </div>
            </header>

            {data.biography && (
                <BiographyClamp text={data.biography} />
            )}

            <section className="space-y-3">
                <h3 className="text-sm font-bold text-white/80 uppercase tracking-wider">
                    {t("person.known_for", "Filmographie")}
                </h3>
                {credits.length === 0 ? (
                    <p className="text-[--muted] text-sm">
                        {t("person.no_credits", "Aucun crédit cast disponible.")}
                    </p>
                ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                        {credits.map(c => (
                            <CreditCard key={`${c.media_type}-${c.id}`} credit={c} onClick={() => onPickCredit(c)} />
                        ))}
                    </div>
                )}
            </section>
        </div>
    )
}

function CreditCard({ credit, onClick }: { credit: TMDBPersonCredit; onClick: () => void }) {
    const img = tmdbImage("w300", credit.poster_path)
    const title = credit.title || credit.name || ""
    const year = (credit.release_date || credit.first_air_date || "").slice(0, 4)
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "group text-left space-y-1.5 rounded-md overflow-hidden",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500",
            )}
        >
            <div className="aspect-[2/3] rounded-md overflow-hidden bg-white/5 border border-white/10 transition-transform group-hover:scale-[1.04]">
                {img ? (
                    <img src={img} alt={title} loading="lazy" className="w-full h-full object-cover" />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-white/40 p-2 text-center">
                        {title}
                    </div>
                )}
            </div>
            <div className="space-y-0.5 px-0.5">
                <p className="text-[11px] text-white font-semibold line-clamp-1">
                    {title}
                </p>
                {(year || credit.character) && (
                    <p className="text-[10px] text-[--muted] line-clamp-1">
                        {year}{year && credit.character ? " · " : ""}{credit.character}
                    </p>
                )}
            </div>
        </button>
    )
}

function BiographyClamp({ text }: { text: string }) {
    const [expanded, setExpanded] = React.useState(false)
    const { t } = useTranslation()
    const isLong = text.length > 380
    return (
        <section className="space-y-2">
            <p className={cn("text-sm text-white/90 whitespace-pre-line", !expanded && isLong && "line-clamp-4")}>
                {text}
            </p>
            {isLong && (
                <button
                    type="button"
                    onClick={() => setExpanded(v => !v)}
                    className="text-xs text-brand-300 hover:text-brand-200 font-semibold"
                >
                    {expanded ? t("person.bio_collapse", "Réduire") : t("person.bio_expand", "Lire la suite")}
                </button>
            )}
        </section>
    )
}

function BodySkeleton() {
    return (
        <div className="p-5 sm:p-6 lg:p-8 space-y-6">
            <header className="flex gap-4">
                <Skeleton className="size-24 sm:size-28 rounded-md" />
                <div className="flex-1 space-y-2">
                    <Skeleton className="h-6 w-48" />
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-32" />
                </div>
            </header>
            <Skeleton className="h-20 w-full rounded-md" />
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {Array.from({ length: 12 }).map((_, i) => (
                    <Skeleton key={i} className="aspect-[2/3] rounded-md" />
                ))}
            </div>
        </div>
    )
}
