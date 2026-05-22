

import { RouteFallback } from "@/components/shared/loading-overlay-with-logo"
import React from "react"

// Legacy /splashscreen route — used to greet the Electron desktop
// client (since removed). Web users never land here in normal use.
// Renders the same discreet spinner the rest of the app uses for
// route transitions, so we don't suddenly flash a big logo at anyone
// who hits this URL by accident.
export default function Page() {
    return <RouteFallback />
}
