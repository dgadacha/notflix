/**
 * Generic error panel — used by AppErrorBoundary, NotFound, etc.
 *
 * Kept under the legacy `luffy-error` name (lots of importers). The
 * iconography has gone through phases:
 *   - originally a Luffy / One Piece mascot (Seanime upstream)
 *   - then a Notflix-N logo with red glow (Phase 3g rebrand)
 *   - now a sober exclamation icon — the N here was flashing during
 *     route transitions when a query throws transiently, which the
 *     user experienced as the "gros N qui apparait des fois". Error
 *     panels shouldn't reuse the brand mark anyway; an error icon is
 *     the standard affordance.
 */
import { Button } from "@/components/ui/button/button"
import { cn } from "@/components/ui/core/styling"
import React from "react"
import { BiErrorCircle } from "react-icons/bi"

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
                    "relative size-20 lg:size-24 rounded-2xl",
                    "bg-[#0a0a0a] border border-red-500/30",
                    "flex items-center justify-center",
                    imageContainerClass,
                )}
            >
                <BiErrorCircle className="size-10 lg:size-12 text-red-400" aria-hidden />
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
