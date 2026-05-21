/**
 * Notflix issue-report page — placeholder. The original Seanime version
 * called a server-side bug-report endpoint. Notflix doesn't expose one.
 */
import React from "react"

export default function IssueReportPage() {
    return (
        <div className="min-h-screen bg-black text-white flex items-center justify-center px-6">
            <div className="max-w-xl text-center space-y-3">
                <h1 className="text-2xl lg:text-3xl font-bold">Signaler un problème</h1>
                <p className="text-[--muted] text-sm">
                    Le formulaire de retour sera bientôt disponible. En attendant,
                    ouvrez une issue sur le dépôt GitHub.
                </p>
            </div>
        </div>
    )
}
