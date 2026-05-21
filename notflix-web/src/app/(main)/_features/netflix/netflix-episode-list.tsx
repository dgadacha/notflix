import { Anime_Entry, Onlinestream_Episode } from "@/api/generated/types"
import { useGetOnlineStreamEpisodeList } from "@/api/hooks/onlinestream.hooks"
import { useHandleOnlinestreamProviderExtensions } from "@/app/(main)/onlinestream/_lib/handle-onlinestream-providers"
import { __onlinestream_selectedDubbedAtom, __onlinestream_selectedProviderAtom } from "@/app/(main)/onlinestream/_lib/onlinestream.atoms"
import { SeaImage } from "@/components/shared/sea-image"
import { cn } from "@/components/ui/core/styling"
import { Select } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { useTranslatedTexts } from "@/lib/translate/use-translated-text"
import { useAtom } from "jotai/react"
import React from "react"
import { useTranslation } from "react-i18next"
import { CgMediaPodcast } from "react-icons/cg"
import { LuExternalLink } from "react-icons/lu"

type Props = {
    animeEntry: Anime_Entry
}

/**
 * Netflix-style episode picker for the Online Streaming tab.
 * Each episode opens the dedicated /watch page in a new tab — the entry
 * page itself stays clean and informational.
 */
export function NetflixEpisodeList({ animeEntry }: Props) {
    const { t } = useTranslation()
    const mediaId = animeEntry.mediaId
    const { providerExtensions, providerExtensionOptions } = useHandleOnlinestreamProviderExtensions()
    const [provider, setProvider] = useAtom(__onlinestream_selectedProviderAtom)
    const [dubbed, setDubbed] = useAtom(__onlinestream_selectedDubbedAtom)

    const extension = React.useMemo(() => providerExtensions.find(p => p.id === provider), [providerExtensions, provider])
    const supportsDub = !!extension?.supportsDub

    const { data, isLoading, isError } = useGetOnlineStreamEpisodeList(mediaId, provider, supportsDub && dubbed)
    const episodes = React.useMemo(
        () => (data?.episodes ?? []).slice().sort((a, b) => a.number - b.number),
        [data?.episodes],
    )

    // Translate every description in a single batched DeepL call.
    const rawDescriptions = React.useMemo(
        () => episodes.map(e => e.description ?? ""),
        [episodes],
    )
    const { texts: translatedDescriptions } = useTranslatedTexts(rawDescriptions)

    const noProvider = !providerExtensionOptions?.length

    return (
        <div className="space-y-6">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                <Select
                    value={provider || ""}
                    options={providerExtensionOptions}
                    onValueChange={setProvider}
                    placeholder={t("entry.pick_provider")}
                    size="sm"
                    leftAddon={<CgMediaPodcast />}
                    fieldClass="w-fit"
                    className="rounded-md"
                />

                {supportsDub && (
                    <label className="flex items-center gap-2 text-sm text-[--muted] cursor-pointer">
                        <Switch value={dubbed} onValueChange={setDubbed} size="sm" />
                        <span>{t("entry.switch_dub")}</span>
                    </label>
                )}
            </div>

            {/* Body */}
            {noProvider && (
                <p className="text-center text-[--muted] py-12 text-sm">
                    {t("entry.no_provider_available")}
                </p>
            )}

            {!noProvider && isLoading && (
                <div className="space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="w-full h-24 rounded-md" />
                    ))}
                </div>
            )}

            {!noProvider && isError && (
                <p className="text-center text-red-300 py-12 text-sm">
                    {t("entry.episodes_load_error")}
                </p>
            )}

            {!noProvider && !isLoading && episodes.length > 0 && (
                <ul className="space-y-2">
                    {episodes.map((ep, i) => (
                        <EpisodeRow
                            key={ep.number}
                            ep={ep}
                            description={translatedDescriptions[i] || ep.description || ""}
                            mediaId={mediaId}
                            provider={provider || ""}
                            dubbed={supportsDub && dubbed}
                            t={t}
                        />
                    ))}
                </ul>
            )}
        </div>
    )
}

function EpisodeRow({
    ep,
    description,
    mediaId,
    provider,
    dubbed,
    t,
}: {
    ep: Onlinestream_Episode
    description: string
    mediaId: number
    provider: string
    dubbed: boolean
    t: (key: string) => string
}) {
    // OnlinestreamPage reads `episode` from the URL — match its convention.
    const href = `/watch?id=${mediaId}&episode=${ep.number}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}${dubbed ? "&dub=1" : ""}`

    return (
        <li>
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                    "group flex gap-4 p-3 rounded-md transition-colors",
                    "bg-white/[0.03] hover:bg-white/[0.07] border border-transparent hover:border-white/10",
                )}
            >
                <div className="relative w-40 lg:w-48 aspect-video rounded-md overflow-hidden bg-gray-900 shrink-0">
                    {ep.image ? (
                        <SeaImage src={ep.image} alt={ep.title || `Episode ${ep.number}`} fill className="object-cover" />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-2xl font-bold text-[--muted]">
                            {ep.number}
                        </div>
                    )}
                    <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-black/70 text-white">
                        {t("entry.episode_short")} {ep.number}
                    </div>
                </div>

                <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                    <div>
                        <h3 className="text-white font-semibold text-base lg:text-lg line-clamp-1">
                            {ep.title || `${t("entry.episode_short")} ${ep.number}`}
                        </h3>
                        {description && (
                            <p className="text-[--muted] text-xs lg:text-sm mt-1 line-clamp-2 leading-relaxed">
                                {description}
                            </p>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[--muted] text-xs opacity-0 group-hover:opacity-100 transition-opacity">
                        <LuExternalLink className="size-3.5" />
                        <span>{t("entry.open_in_new_tab")}</span>
                    </div>
                </div>
            </a>
        </li>
    )
}
