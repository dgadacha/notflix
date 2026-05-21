import { useGetAnimeEntry } from "@/api/hooks/anime_entries.hooks"
import { NetflixPipOnBlur } from "@/app/(main)/_features/netflix/netflix-pip-on-blur"
import { NetflixProfileHistorySaver } from "@/app/(main)/_features/netflix/netflix-profile-history-saver"
import { OnlinestreamPage } from "@/app/(main)/onlinestream/_containers/onlinestream-page"
import {
    __onlinestream_resumeAtSecondsAtom,
    __onlinestream_selectedDubbedAtom,
    __onlinestream_selectedEpisodeNumberAtom,
    __onlinestream_selectedProviderAtom,
} from "@/app/(main)/onlinestream/_lib/onlinestream.atoms"
import { LoadingOverlayWithLogo } from "@/components/shared/loading-overlay-with-logo"
import { SeaImage } from "@/components/shared/sea-image"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useSearchParams } from "@/lib/navigation"
import { useSetAtom } from "jotai/react"
import React from "react"
import { useTranslation } from "react-i18next"
import { BiPlay } from "react-icons/bi"

function formatHMS(total: number): string {
    if (!Number.isFinite(total) || total < 0) return "00:00"
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = Math.floor(total % 60)
    const pad = (n: number) => String(n).padStart(2, "0")
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export default function WatchPage() {
    const { t } = useTranslation()
    const searchParams = useSearchParams()
    const idParam = searchParams.get("id")
    // accept both ?episode= (matches OnlinestreamPage internal convention) and ?ep= (legacy)
    const epParam = searchParams.get("episode") ?? searchParams.get("ep")
    const providerParam = searchParams.get("provider")
    const dubParam = searchParams.get("dub")
    const tParam = searchParams.get("t")

    const mediaId = idParam ? parseInt(idParam, 10) : NaN
    const epNumber = epParam ? parseInt(epParam, 10) : NaN
    const resumeSeconds = tParam ? parseInt(tParam, 10) : NaN

    const setEpisode = useSetAtom(__onlinestream_selectedEpisodeNumberAtom)
    const setProvider = useSetAtom(__onlinestream_selectedProviderAtom)
    const setDubbed = useSetAtom(__onlinestream_selectedDubbedAtom)
    const setResumeAt = useSetAtom(__onlinestream_resumeAtSecondsAtom)

    // The player only mounts after the user clicks. The click counts as a
    // browser user-gesture, which lets the player call .play() with sound.
    const [started, setStarted] = React.useState(false)

    const handleStart = React.useCallback(() => {
        // Atoms must be set BEFORE the player mounts so its first render picks them up.
        if (!Number.isNaN(epNumber)) setEpisode(epNumber)
        if (providerParam) setProvider(providerParam)
        if (dubParam === "1") setDubbed(true)
        // Player will consume + clear this on first onLoadedMetadata.
        if (!Number.isNaN(resumeSeconds) && resumeSeconds > 0) setResumeAt(resumeSeconds)
        setStarted(true)
    }, [epNumber, providerParam, dubParam, resumeSeconds, setEpisode, setProvider, setDubbed, setResumeAt])

    const { data: animeEntry, isLoading } = useGetAnimeEntry(mediaId)

    if (Number.isNaN(mediaId)) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center text-[--muted]">
                Missing or invalid <code className="mx-1 px-1.5 py-0.5 bg-white/10 rounded">id</code> query param.
            </div>
        )
    }

    // The player needs the entry. We only block the *player* render on it,
    // not the splash — that way new tabs always see the splash instantly,
    // even if the API call is slow / hasn't returned yet.
    if (started) {
        if (!animeEntry) return <LoadingOverlayWithLogo title={t("watch.start")} />
        return (
            <div data-watch-page className="min-h-screen bg-black -mt-16 lg:-mt-[68px]">
                {/* Per-profile watch history mirror — see netflix-profile-history-saver. */}
                <NetflixProfileHistorySaver />
                {/* Pop the video into Picture-in-Picture when the user switches tabs. */}
                <NetflixPipOnBlur />
                <OnlinestreamPage
                    animeEntry={animeEntry}
                    animeEntryLoading={isLoading}
                    hideBackButton
                />
            </div>
        )
    }

    // Pre-play splash — Netflix/YouTube-style. Renders immediately.
    const banner = animeEntry?.media?.bannerImage || animeEntry?.media?.coverImage?.extraLarge || ""
    const title = animeEntry?.media?.title?.userPreferred ?? ""

    return (
        <div data-watch-splash className="min-h-screen bg-black -mt-16 lg:-mt-[68px] relative overflow-hidden">
            {banner && (
                <SeaImage
                    src={banner}
                    alt=""
                    fill
                    priority
                    className="object-cover object-center opacity-50"
                />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/30" />

            <div className="relative z-[1] min-h-screen flex flex-col items-center justify-center px-6 text-center gap-6">
                <p className="uppercase tracking-widest text-xs lg:text-sm text-brand-400 font-semibold">
                    {t("entry.episode_short")} {Number.isNaN(epNumber) ? "?" : epNumber}
                </p>
                {title ? (
                    <h1 className="text-3xl lg:text-5xl font-extrabold text-white max-w-3xl drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
                        {title}
                    </h1>
                ) : (
                    <Skeleton className="h-12 w-80 max-w-full" />
                )}

                <Button
                    onClick={handleStart}
                    size="xl"
                    leftIcon={<BiPlay className="text-3xl" />}
                    className="bg-white !text-black hover:!bg-white/90 font-bold px-10 rounded-md mt-4"
                    autoFocus
                >
                    {!Number.isNaN(resumeSeconds) && resumeSeconds > 0
                        ? `${t("watch.resume_at")} ${formatHMS(resumeSeconds)}`
                        : t("watch.start")}
                </Button>

                <p className="text-xs text-[--muted] max-w-md mt-2">
                    {t("watch.click_hint")}
                </p>
            </div>
        </div>
    )
}
