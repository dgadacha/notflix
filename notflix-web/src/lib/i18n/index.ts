import i18n from "i18next"
import LanguageDetector from "i18next-browser-languagedetector"
import { initReactI18next } from "react-i18next"
import en from "./locales/en.json"
import fr from "./locales/fr.json"

export const SUPPORTED_LANGUAGES = ["fr", "en"] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
    fr: "Français",
    en: "English",
}

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            en: { translation: en },
            fr: { translation: fr },
        },
        fallbackLng: "fr",
        supportedLngs: SUPPORTED_LANGUAGES,
        interpolation: {
            escapeValue: false, // React already escapes by default
        },
        detection: {
            order: ["localStorage", "navigator"],
            caches: ["localStorage"],
            lookupLocalStorage: "notflix-lng",
        },
    })

export function setLanguage(lng: SupportedLanguage) {
    i18n.changeLanguage(lng)
}

export default i18n
