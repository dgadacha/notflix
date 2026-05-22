import React from "react"

/**
 * The big-N splash component has been retired. The user reported it
 * surfacing on every window refocus / route change as
 *   "le gros N qui apparaît des fois"
 * which is the worst kind of loading affordance — disruptive, on a
 * timer the user doesn't control.
 *
 * Both functions in this file now render the same small spinner. We
 * keep the named exports (LoadingOverlayWithLogo, RouteFallback) so
 * any caller we missed in the grep doesn't break the build.
 *
 * If you genuinely need a fullscreen branded splash later, build a
 * new component — don't resurrect this one.
 */
function Spinner() {
    return (
        <div className="fixed inset-0 z-[40] flex items-center justify-center pointer-events-none bg-black/30 backdrop-blur-[2px]">
            <div className="size-10 rounded-full border-4 border-white/10 border-t-brand-500 animate-spin" />
        </div>
    )
}

// Kept for any external caller — never renders the big logo anymore.
// `refetch` / `title` props are accepted but ignored; they only made
// sense when the splash had a meaningful "Reload" CTA.
export function LoadingOverlayWithLogo(_props: { refetch?: () => void; title?: string }) {
    return <Spinner />
}

/**
 * Lightweight loading indicator for route transitions. Small spinner
 * over a translucent backdrop — does not pull focus. Used as
 * `pendingComponent` on the root route.
 */
export function RouteFallback() {
    return <Spinner />
}
