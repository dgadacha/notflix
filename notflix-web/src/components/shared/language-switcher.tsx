import { LANGUAGE_LABELS, setLanguage, SUPPORTED_LANGUAGES, SupportedLanguage } from "@/lib/i18n"
import { cn } from "@/components/ui/core/styling"
import React from "react"
import { useTranslation } from "react-i18next"

type Props = {
    /** Render compact (icons-only-ish) variant for collapsed sidebars. */
    compact?: boolean
    className?: string
}

export function LanguageSwitcher({ compact, className }: Props) {
    const { i18n } = useTranslation()
    const current = (i18n.resolvedLanguage as SupportedLanguage) ?? "fr"

    return (
        <div
            role="radiogroup"
            aria-label="Language"
            className={cn(
                "inline-flex items-center gap-0.5 rounded-full p-0.5",
                "bg-white/5 border border-white/10",
                className,
            )}
        >
            {SUPPORTED_LANGUAGES.map((lng) => {
                const isCurrent = current === lng
                return (
                    <button
                        key={lng}
                        type="button"
                        role="radio"
                        aria-checked={isCurrent}
                        title={LANGUAGE_LABELS[lng]}
                        onClick={() => setLanguage(lng)}
                        className={cn(
                            "px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider rounded-full transition-colors",
                            isCurrent
                                ? "bg-brand-500 text-white"
                                : "text-[--muted] hover:text-white",
                        )}
                    >
                        {compact ? lng.toUpperCase() : lng.toUpperCase()}
                    </button>
                )
            })}
        </div>
    )
}
