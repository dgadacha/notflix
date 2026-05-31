/**
 * Dialog "Importer un .torrent" → l'utilisateur drop un fichier
 * .torrent, le backend le pousse à TorBox, parse + match TMDB chaque
 * fichier vidéo, et persiste les rows LocalFile avec source="torbox".
 *
 * Les entrées importées apparaissent dans la rangée "Bibliothèque
 * locale" du home (route via /resolve-stream à la lecture).
 */
import { Modal } from "@/components/ui/modal"
import { cn } from "@/components/ui/core/styling"
import { useQueryClient } from "@tanstack/react-query"
import React from "react"

type ImportResult = {
    torrentId: number
    name: string
    imported: number
    skipped: number
    failed: number
    errors?: string[]
}

export function LocalLibraryImportDialog({
    open,
    onClose,
}: {
    open: boolean
    onClose: () => void
}) {
    const qc = useQueryClient()
    const fileInputRef = React.useRef<HTMLInputElement>(null)
    const [uploading, setUploading] = React.useState(false)
    const [result, setResult] = React.useState<ImportResult | null>(null)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        if (open) {
            setUploading(false)
            setResult(null)
            setError(null)
        }
    }, [open])

    // Capture-phase window-level drag handlers (même pattern que
    // TorrentSourceDialog) pour qu'un drop n'importe où sur la
    // page soit attrapé tant que ce dialog est ouvert.
    React.useEffect(() => {
        if (!open || result) return
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
    }, [open, result]) // eslint-disable-line react-hooks/exhaustive-deps

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
            const r = await fetch("/api/v1/local-library/import-torrent", {
                method: "POST",
                body: fd,
            })
            if (!r.ok) {
                const j = await r.json().catch(() => ({}))
                throw new Error(j.error ?? `import ${r.status}`)
            }
            const j = await r.json()
            setResult((j.data ?? j) as ImportResult)
            // Refresh la rangée Bibliothèque locale.
            qc.invalidateQueries({ queryKey: ["local-library"] })
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setUploading(false)
        }
    }

    return (
        <Modal
            open={open}
            onOpenChange={(v) => { if (!v) onClose() }}
            title="Importer un .torrent dans la bibliothèque"
            description="Le .torrent est envoyé à TorBox, chaque fichier vidéo est matché contre TMDB, puis ils apparaissent dans ta rangée « Bibliothèque locale » comme s'ils étaient en local."
            contentClass="max-w-xl"
        >
            <div className="space-y-3">
                {!result && (
                    <div
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
                                    TorBox récupère + matching TMDB en cours…
                                </p>
                                <p className="text-[--muted] text-xs">
                                    Ça peut prendre 30-90s si le torrent n'est pas en cache TorBox.
                                </p>
                            </div>
                        ) : (
                            <>
                                <p className="text-white font-semibold text-sm">
                                    Glisse ton .torrent ici ou clique pour parcourir
                                </p>
                                <p className="text-[--muted] text-xs mt-1 max-w-md mx-auto">
                                    Chaque vidéo dans le torrent sera ajoutée à ta
                                    bibliothèque. Tu pourras les jouer comme tes
                                    fichiers locaux (lecture via TorBox).
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

                {result && (
                    <div className="space-y-3">
                        <div className="bg-black/30 border border-white/10 rounded-md p-3 space-y-2 text-xs">
                            <p className="text-white/80 font-semibold truncate" title={result.name}>
                                {result.name}
                            </p>
                            <div className="flex flex-wrap gap-3 text-[11px]">
                                <span className="text-emerald-300">
                                    ✓ {result.imported} ajoutés
                                </span>
                                {result.skipped > 0 && (
                                    <span className="text-white/60">
                                        ↷ {result.skipped} ignorés (non-vidéo ou pas de match)
                                    </span>
                                )}
                                {result.failed > 0 && (
                                    <span className="text-red-300">
                                        ✗ {result.failed} échecs
                                    </span>
                                )}
                            </div>
                            {result.errors && result.errors.length > 0 && (
                                <details>
                                    <summary className="text-red-300/80 text-[10px] cursor-pointer">
                                        Détail des erreurs ({result.errors.length})
                                    </summary>
                                    <ul className="mt-1 space-y-0.5 text-[10px] text-red-300/70 font-mono break-all">
                                        {result.errors.map((e, i) => (
                                            <li key={i}>{e}</li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => { setResult(null); setError(null) }}
                                className={cn(
                                    "px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider",
                                    "bg-white/10 hover:bg-white/15 text-white",
                                )}
                            >
                                Importer un autre
                            </button>
                            <button
                                type="button"
                                onClick={onClose}
                                className={cn(
                                    "px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider",
                                    "bg-brand-500 hover:bg-brand-400 text-white",
                                )}
                            >
                                Voir la bibliothèque
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    )
}
