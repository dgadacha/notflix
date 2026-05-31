/**
 * Dialog "Source personnalisée (.torrent)" — permet à l'admin de
 * lancer la lecture depuis un .torrent qu'il fournit lui-même au
 * lieu de passer par la recherche Prowlarr.
 *
 * Flow :
 *   1. L'utilisateur drop un .torrent
 *   2. Backend : POST /torbox/upload-torrent (multipart)
 *      → TorBox récupère le torrent + retourne {torrentId, files}
 *   3. Liste les fichiers vidéo, auto-highlight celui qui match
 *      SxxExx si on a un contexte TV (season/episode)
 *   4. Click sur un fichier → POST /torbox/play (avec torrentId
 *      pour skip l'add+poll)
 *   5. Stash le streamUrl + metadata dans sessionStorage
 *   6. Navigate vers /watch?customStream=1 qui lit le payload et
 *      court-circuite la recherche Prowlarr.
 */
import { Modal } from "@/components/ui/modal"
import { cn } from "@/components/ui/core/styling"
import { useRouter } from "@/lib/navigation"
import React from "react"

type UploadedFile = {
    id: number
    name: string
    size: number
    isVideo: boolean
}

type UploadResult = {
    torrentId: number
    name: string
    cached: boolean
    files: UploadedFile[]
}

type PlayResult = {
    streamUrl: string
    torrentId: number
    fileId: number
    torrentName: string
    audioCodec: string
    videoCodec: string
    container: string
    durationSec: number
    subtitles: any[]
    sessionId: string
}

// Key under which we stash the play result for /watch to pick up.
const STASH_KEY = "notflix-custom-stream"

export type TorrentSourceContext = {
    /** TMDB id of the title the user is watching (for history saving). */
    tmdbId: number
    /** "movie" | "tv". */
    mediaType: "movie" | "tv"
    /** Optional title (for the watch history). */
    title?: string
    posterPath?: string
    backdropPath?: string
    /** For TV: season/episode to hint SxxExx matching in the picker. */
    season?: number
    episode?: number
}

function fmtSize(bytes: number): string {
    if (bytes <= 0) return "—"
    const units = ["B", "KB", "MB", "GB", "TB"]
    let v = bytes
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Best-effort: does the file name match the season/episode pattern? */
function matchesEpisode(name: string, season?: number, episode?: number): boolean {
    if (!season || !episode) return false
    const lower = name.toLowerCase()
    const patterns = [
        `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`,
        `s${season}e${episode}`,
        `${season}x${String(episode).padStart(2, "0")}`,
        `${season}x${episode}`,
    ]
    return patterns.some(p => lower.includes(p))
}

export function TorrentSourceDialog({
    open,
    onClose,
    context,
}: {
    open: boolean
    onClose: () => void
    context: TorrentSourceContext | null
}) {
    const router = useRouter()
    const [uploadResult, setUploadResult] = React.useState<UploadResult | null>(null)
    const [uploading, setUploading] = React.useState(false)
    const [playing, setPlaying] = React.useState<number | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const fileInputRef = React.useRef<HTMLInputElement>(null)

    // Picker S/E pour les torrents multi-saisons. Initialisé depuis
    // le contexte (modal ouverte sur S04 → S04E01 par défaut), mais
    // l'utilisateur peut le changer pour cibler n'importe quel
    // épisode du pack. Pilote le tri + le badge ★ MATCH.
    const [pickSeason, setPickSeason] = React.useState<number>(context?.season ?? 1)
    const [pickEpisode, setPickEpisode] = React.useState<number>(context?.episode ?? 1)

    // Reset state every time the dialog opens for a new context.
    React.useEffect(() => {
        if (open) {
            setUploadResult(null)
            setUploading(false)
            setPlaying(null)
            setError(null)
            setPickSeason(context?.season ?? 1)
            setPickEpisode(context?.episode ?? 1)
        }
    }, [open, context?.season, context?.episode])

    // Document-level drag/drop handlers en PHASE CAPTURE — c'est
    // important : Radix Dialog peut faire un stopPropagation côté
    // bubble, ce qui empêcherait nos window listeners de se
    // déclencher (l'utilisateur voyait son fichier s'ouvrir
    // derrière la modal). Avec capture=true on attrape l'event en
    // route descendante, AVANT que Radix puisse y toucher.
    //
    // preventDefault sur dragenter ET dragover EST OBLIGATOIRE
    // pour activer le drop (specs HTML5) — sans ça, le browser
    // refuse le drop et ouvre le fichier comme navigation.
    React.useEffect(() => {
        if (!open || uploadResult) return
        const onDragEnter = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
        }
        const onDragOver = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
        }
        const onDrop = (e: DragEvent) => {
            const files = e.dataTransfer?.files
            if (!files || files.length === 0) return
            e.preventDefault()
            e.stopPropagation()
            void handleFile(files[0])
        }
        document.addEventListener("dragenter", onDragEnter, true)
        document.addEventListener("dragover", onDragOver, true)
        document.addEventListener("drop", onDrop, true)
        return () => {
            document.removeEventListener("dragenter", onDragEnter, true)
            document.removeEventListener("dragover", onDragOver, true)
            document.removeEventListener("drop", onDrop, true)
        }
    }, [open, uploadResult]) // eslint-disable-line react-hooks/exhaustive-deps

    const handleFile = async (file: File) => {
        if (!file.name.toLowerCase().endsWith(".torrent")) {
            setError("Fichier .torrent attendu")
            return
        }
        setError(null)
        setUploading(true)
        try {
            const fd = new FormData()
            fd.append("torrent", file)
            const r = await fetch("/api/v1/torbox/upload-torrent", {
                method: "POST",
                body: fd,
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                throw new Error(j.error ?? `upload ${r.status}`)
            }
            const j = await r.json()
            const data = (j.data ?? j) as UploadResult
            setUploadResult(data)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setUploading(false)
        }
    }

    const onClickPlay = async (file: UploadedFile) => {
        if (!uploadResult || !context) return
        setPlaying(file.id)
        setError(null)
        try {
            const playBody: any = {
                torrentId: uploadResult.torrentId,
                fileId: file.id,
            }
            // Pass the user-picked S/E rather than the modal context.
            // For TV the user might be diving into a different episode
            // than the one currently selected in the modal.
            if (context.mediaType === "tv") {
                if (pickSeason > 0) playBody.season = pickSeason
                if (pickEpisode > 0) playBody.episode = pickEpisode
            }

            const r = await fetch("/api/v1/torbox/play", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(playBody),
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                throw new Error(j.error ?? `play ${r.status}`)
            }
            const j = await r.json()
            const data = (j.data ?? j) as PlayResult

            // Stash the result for /watch to read.
            try {
                sessionStorage.setItem(STASH_KEY, JSON.stringify({
                    ...data,
                    context,
                    expiresAt: Date.now() + 60_000, // 1 min freshness
                }))
            } catch {
                // Best-effort — if sessionStorage is full, the user will
                // just hit the Prowlarr search flow.
            }

            const params = new URLSearchParams({
                customStream: "1",
                id: String(context.tmdbId),
                type: context.mediaType,
            })
            if (context.mediaType === "tv") {
                params.set("season", String(pickSeason))
                params.set("episode", String(pickEpisode))
            }
            router.push(`/watch?${params.toString()}`)
            onClose()
        } catch (e) {
            setError((e as Error).message)
            setPlaying(null)
        }
    }

    // Sort: episode-matching first, then videos, then everything else.
    const isTV = context?.mediaType === "tv"
    const sortedFiles = React.useMemo(() => {
        if (!uploadResult) return []
        const arr = [...uploadResult.files]
        const season = isTV ? pickSeason : undefined
        const episode = isTV ? pickEpisode : undefined
        arr.sort((a, b) => {
            const aMatch = matchesEpisode(a.name, season, episode) ? 1 : 0
            const bMatch = matchesEpisode(b.name, season, episode) ? 1 : 0
            if (aMatch !== bMatch) return bMatch - aMatch
            if (a.isVideo !== b.isVideo) return a.isVideo ? -1 : 1
            return a.name.localeCompare(b.name)
        })
        return arr
    }, [uploadResult, isTV, pickSeason, pickEpisode])

    return (
        <Modal
            open={open}
            onOpenChange={(v) => { if (!v) onClose() }}
            title="Source personnalisée (.torrent)"
            description={context
                ? `Lance la lecture depuis un fichier .torrent que tu fournis. ${
                    context.season && context.episode
                        ? `Saison ${context.season}, épisode ${context.episode} — le fichier qui match S${String(context.season).padStart(2, "0")}E${String(context.episode).padStart(2, "0")} sera mis en haut.`
                        : ""
                }`.trim()
                : undefined
            }
            // z-[100] : le NetflixDetailModal parent utilise le
            // z-index Radix par défaut (~z-50) ; cette modal est
            // imbriquée dedans, sans override elle passe DERRIÈRE
            // le parent. On la force au-dessus.
            overlayClass="z-[100]"
            contentClass="max-w-2xl z-[100]"
        >
            <div className="space-y-3">
                {!uploadResult && (
                    <div
                        onDragOver={(e) => { e.preventDefault() }}
                        onDrop={(e) => {
                            e.preventDefault()
                            const f = e.dataTransfer.files?.[0]
                            if (f) handleFile(f)
                        }}
                        onClick={() => fileInputRef.current?.click()}
                        className={cn(
                            "border-2 border-dashed border-white/15 rounded-md",
                            "p-8 text-center cursor-pointer",
                            "hover:border-brand-500/60 hover:bg-white/5 transition-colors",
                            uploading && "opacity-50 pointer-events-none",
                        )}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".torrent,application/x-bittorrent"
                            className="hidden"
                            onChange={(e) => {
                                const f = e.target.files?.[0]
                                if (f) handleFile(f)
                                e.target.value = ""
                            }}
                        />
                        {uploading ? (
                            <div className="flex flex-col items-center gap-3">
                                <div className="size-8 rounded-full border-4 border-white/10 border-t-brand-500 animate-spin" />
                                <p className="text-white/80 text-sm">
                                    Envoi à TorBox en cours… (peut prendre 30-90s si pas en cache)
                                </p>
                            </div>
                        ) : (
                            <>
                                <p className="text-white font-semibold text-sm">
                                    Glisse ton .torrent ici ou clique pour parcourir
                                </p>
                                <p className="text-[--muted] text-xs mt-1">
                                    Le fichier est uploadé à TorBox qui le télécharge
                                    (instantané si en cache).
                                </p>
                            </>
                        )}
                    </div>
                )}

                {error && (
                    <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2 break-words">
                        {error}
                    </p>
                )}

                {uploadResult && (
                    <>
                        <div className="text-xs text-[--muted] flex items-center gap-2">
                            <span className={cn(
                                "size-1.5 rounded-full",
                                uploadResult.cached ? "bg-emerald-400" : "bg-amber-400",
                            )} />
                            <span className="truncate flex-1" title={uploadResult.name}>
                                {uploadResult.name}
                            </span>
                            <span>{uploadResult.cached ? "en cache" : "téléchargé"}</span>
                        </div>

                        {/* Picker S/E — pour les torrents qui contiennent
                            plusieurs saisons / épisodes. Permet de
                            déplacer le badge ★ MATCH sur l'épisode
                            qu'on veut vraiment regarder. */}
                        {isTV && (
                            <div className="flex items-center gap-2 bg-black/30 border border-white/10 rounded-md px-3 py-2 text-xs">
                                <span className="text-white/70 font-semibold">Je veux</span>
                                <label className="flex items-center gap-1">
                                    <span className="text-[--muted]">S</span>
                                    <input
                                        type="number"
                                        min={1}
                                        max={99}
                                        value={pickSeason}
                                        onChange={(e) => setPickSeason(Math.max(1, parseInt(e.target.value, 10) || 1))}
                                        className="w-12 bg-black/40 border border-white/15 rounded px-1.5 py-0.5 text-white tabular-nums outline-none focus:border-brand-500"
                                    />
                                </label>
                                <label className="flex items-center gap-1">
                                    <span className="text-[--muted]">E</span>
                                    <input
                                        type="number"
                                        min={1}
                                        max={999}
                                        value={pickEpisode}
                                        onChange={(e) => setPickEpisode(Math.max(1, parseInt(e.target.value, 10) || 1))}
                                        className="w-12 bg-black/40 border border-white/15 rounded px-1.5 py-0.5 text-white tabular-nums outline-none focus:border-brand-500"
                                    />
                                </label>
                                <span className="text-[--muted] text-[10px] ml-auto">
                                    le fichier qui match remontera en haut avec ★ MATCH
                                </span>
                            </div>
                        )}

                        <div className="max-h-[55vh] overflow-y-auto space-y-1.5 pr-1">
                            {sortedFiles.length === 0 && (
                                <p className="text-[--muted] text-sm text-center py-6">
                                    Aucun fichier dans ce torrent.
                                </p>
                            )}
                            {sortedFiles.map(file => {
                                const isMatch = matchesEpisode(file.name,
                                    isTV ? pickSeason : undefined,
                                    isTV ? pickEpisode : undefined,
                                )
                                const isPlayingThis = playing === file.id
                                return (
                                    <button
                                        key={file.id}
                                        type="button"
                                        onClick={() => file.isVideo && onClickPlay(file)}
                                        disabled={!file.isVideo || playing !== null}
                                        className={cn(
                                            "w-full text-left flex items-center gap-3 px-3 py-2 rounded-md text-xs",
                                            "transition-colors",
                                            file.isVideo
                                                ? "bg-black/30 hover:bg-white/10 border border-white/5 hover:border-white/15 cursor-pointer"
                                                : "bg-black/10 border border-transparent text-white/40 cursor-not-allowed",
                                            isMatch && "ring-1 ring-brand-500/60",
                                            playing !== null && !isPlayingThis && "opacity-40",
                                        )}
                                    >
                                        <span className="flex-1 min-w-0 break-all">
                                            {isMatch && (
                                                <span className="text-brand-300 font-bold mr-1.5">
                                                    ★ MATCH
                                                </span>
                                            )}
                                            {file.name}
                                        </span>
                                        <span className="text-[10px] text-[--muted] tabular-nums shrink-0">
                                            {fmtSize(file.size)}
                                        </span>
                                        {isPlayingThis && (
                                            <div className="size-3.5 rounded-full border-2 border-white/10 border-t-brand-500 animate-spin shrink-0" />
                                        )}
                                    </button>
                                )
                            })}
                        </div>

                        <button
                            type="button"
                            onClick={() => { setUploadResult(null); setError(null) }}
                            disabled={playing !== null}
                            className="text-[11px] text-[--muted] hover:text-white transition-colors disabled:opacity-50"
                        >
                            ← Charger un autre .torrent
                        </button>
                    </>
                )}
            </div>
        </Modal>
    )
}

/** Reads (and consumes) the stashed play result from sessionStorage.
 *  Called by the /watch page when `?customStream=1` is set. Returns
 *  null if no fresh stash is found. */
export function consumeCustomStream(): (PlayResult & { context: TorrentSourceContext }) | null {
    try {
        const raw = sessionStorage.getItem(STASH_KEY)
        if (!raw) return null
        sessionStorage.removeItem(STASH_KEY) // single-use
        const parsed = JSON.parse(raw)
        if (typeof parsed.expiresAt !== "number" || parsed.expiresAt < Date.now()) {
            return null
        }
        return parsed
    } catch {
        return null
    }
}
