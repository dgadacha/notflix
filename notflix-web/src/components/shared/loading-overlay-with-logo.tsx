import { GradientBackground } from "@/components/shared/gradient-background"
import { TextGenerateEffect } from "@/components/shared/text-generate-effect"
import { Button } from "@/components/ui/button"
import { LoadingOverlay } from "@/components/ui/loading-spinner"
import { __isDesktop__ } from "@/types/constants"
import { SeaImage } from "@/components/shared/sea-image"
import React from "react"

/**
 * Full-screen Notflix splash used for genuinely-long waits: initial auth
 * check, the dedicated /splashscreen route, cold app boot. NOT a good
 * fit for in-app route transitions — for those use RouteFallback which
 * is just a thin spinner. The big logo flashing between pages was
 * confusing the user ("logo N en super gros qui apparaît brièvement").
 */
export function LoadingOverlayWithLogo({ refetch, title }: { refetch?: () => void, title?: string }) {
    return <LoadingOverlay showSpinner={false}>
        <SeaImage
            src="/notflix-logo.svg"
            alt="Loading..."
            priority
            width={100}
            height={100}
            className="animate-pulse z-[1]"
        />
        <GradientBackground />
        <TextGenerateEffect className="text-lg mt-2 text-[--muted] animate-pulse z-[1]" words={title ?? "N O T F L I X"} />

        {(__isDesktop__ && !!refetch) && (
            <Button
                onClick={() => window.location.reload()}
                className="mt-4 z-[1]"
                intent="gray-outline"
                size="sm"
            >Reload</Button>
        )}
    </LoadingOverlay>
}

/**
 * Lightweight loading indicator for route transitions. No fullscreen
 * overlay, no logo, no text — just a small centered spinner that
 * doesn't pull focus during everyday navigation. Used as
 * `pendingComponent` on the root route; pendingMs is set high enough
 * (600 ms) that fast transitions don't render this at all.
 */
export function RouteFallback() {
    return (
        <div className="fixed inset-0 z-[40] flex items-center justify-center pointer-events-none bg-black/30 backdrop-blur-[2px]">
            <div className="size-10 rounded-full border-4 border-white/10 border-t-brand-500 animate-spin" />
        </div>
    )
}
