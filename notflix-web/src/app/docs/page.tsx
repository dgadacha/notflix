/**
 * Notflix docs page — placeholder. Seanime served a generated API docs site
 * from its Go backend; Notflix doesn't ship one yet.
 */
import React from "react"

export default function DocsPage() {
    return (
        <div className="min-h-screen bg-black text-white flex items-center justify-center px-6">
            <div className="max-w-xl text-center space-y-3">
                <h1 className="text-2xl lg:text-3xl font-bold">Documentation</h1>
                <p className="text-[--muted] text-sm">
                    La documentation de l'API Notflix sera bientôt disponible.
                </p>
            </div>
        </div>
    )
}
