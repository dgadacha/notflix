/**
 * Generic error panel — used by AppErrorBoundary, NotFound, etc.
 *
 * Kept under the legacy `luffy-error` name (lots of importers) but the
 * Luffy / One Piece mascot was retired with Phase 3g rebrand. The panel
 * is now a sober Notflix-N logo with a red glow, matching the rest of
 * the app's visual language.
 */
import { Button } from "@/components/ui/button/button"
import { cn } from "@/components/ui/core/styling"
import React from "react"

interface LuffyErrorProps {
    children?: React.ReactNode
    className?: string
    reset?: () => void
    title?: string | null
    showRefreshButton?: boolean
    imageContainerClass?: string
}

export const LuffyError: React.FC<LuffyErrorProps> = (props) => {
    const { children, reset, className, title = "Oops!", showRefreshButton = false, imageContainerClass } = props

    return (
        <div data-luffy-error className={cn("w-full flex flex-col items-center mt-10 space-y-5", className)}>
            <div
                data-luffy-error-image-container
                className={cn(
                    "relative size-24 lg:size-28 rounded-2xl",
                    "bg-[#0a0a0a] border border-white/5",
                    "shadow-[0_0_60px_-15px_rgba(229,9,20,0.6)]",
                    "flex items-center justify-center overflow-hidden",
                    imageContainerClass,
                )}
            >
                {/* Notflix N mark — same shape as public/notflix-logo.svg
                    but inlined here so the error panel renders even if
                    the static asset can't be loaded. */}
                <svg viewBox="0 0 100 100" className="size-16 lg:size-20" role="img" aria-label="Notflix">
                    <path
                        fill="#E50914"
                        d="M22 16 L38 16 L62 68 L62 16 L78 16 L78 84 L62 84 L38 32 L38 84 L22 84 Z"
                    />
                </svg>
            </div>

            <div data-luffy-error-content className="text-center space-y-3 max-w-md">
                {!!title && (
                    <h3 data-luffy-error-title className="text-white text-xl lg:text-2xl font-bold">
                        {title}
                    </h3>
                )}
                <div data-luffy-error-content-children className="text-[--muted] text-sm lg:text-base">
                    {children}
                </div>
                <div data-luffy-error-content-buttons>
                    {(showRefreshButton && !reset) && (
                        <Button
                            data-luffy-error-content-button-refresh
                            intent="warning-subtle"
                            onClick={() => window.location.reload()}
                        >
                            Réessayer
                        </Button>
                    )}
                    {!!reset && (
                        <Button data-luffy-error-content-button-reset intent="warning-subtle" onClick={reset}>
                            Réessayer
                        </Button>
                    )}
                </div>
            </div>
        </div>
    )
}
