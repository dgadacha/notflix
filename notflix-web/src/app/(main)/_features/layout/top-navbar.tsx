import { ManualProgressTrackingButton } from "@/app/(main)/_features/progress-tracking/manual-progress-tracking"
import { PlaybackManagerProgressTrackingButton } from "@/app/(main)/_features/progress-tracking/playback-manager-progress-tracking"
import { useThemeSettings } from "@/lib/theme/theme-hooks"
import { __isDesktop__ } from "@/types/constants"
import React from "react"

type SidebarNavbarProps = {
    isCollapsed: boolean
    handleExpandSidebar: () => void
    handleUnexpandedSidebar: () => void
}

/**
 * Compact navbar embedded inside the offline sidebar — exposes the
 * playback + manual tracking buttons. The main app uses NetflixTopBar
 * everywhere else.
 */
export function SidebarNavbar(props: SidebarNavbarProps) {
    const { handleExpandSidebar, handleUnexpandedSidebar } = props
    const ts = useThemeSettings()

    if (!ts.hideTopNavbar && !__isDesktop__) return null

    return (
        <div
            data-sidebar-navbar
            className="flex flex-col gap-1"
            onMouseEnter={handleExpandSidebar}
            onMouseLeave={handleUnexpandedSidebar}
        >
            <div data-sidebar-navbar-playback-manager-progress-tracking-button className="flex justify-center">
                <PlaybackManagerProgressTrackingButton asSidebarButton />
            </div>
            <div data-sidebar-navbar-manual-progress-tracking-button className="flex justify-center">
                <ManualProgressTrackingButton asSidebarButton />
            </div>
        </div>
    )
}
