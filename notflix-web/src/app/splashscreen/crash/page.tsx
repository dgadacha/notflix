/**
 * Crash splashscreen — surfaced by the Electron client when the wrapper
 * fails to launch. Notflix is web-only so this is just a minimal fallback
 * UI in case something explicit lands the user here.
 */
import React from "react"

export default function CrashPage() {
    return (
        <div className="min-h-screen bg-black text-white flex items-center justify-center px-6">
            <div className="max-w-xl text-center space-y-4">
                <h1 className="text-3xl lg:text-4xl font-extrabold tracking-tight">
                    Notflix a rencontré un problème
                </h1>
                <p className="text-[--muted] text-sm">
                    Veuillez recharger la page.
                </p>
            </div>
        </div>
    )
}
