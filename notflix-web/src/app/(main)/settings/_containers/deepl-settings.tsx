import { useDeeplKey, useTranslatedText } from "@/lib/translate/use-translated-text"
import { Button } from "@/components/ui/button"
import { TextInput } from "@/components/ui/text-input"
import React from "react"
import { useTranslation } from "react-i18next"
import { LuCheck, LuKeyRound } from "react-icons/lu"

const SAMPLE_EN = "A young swordsman embarks on an adventure across the sea to find his destiny."

export function DeeplSettings() {
    const { t } = useTranslation()
    const [storedKey, setStoredKey] = useDeeplKey()
    const [draft, setDraft] = React.useState(storedKey)
    const [testEnabled, setTestEnabled] = React.useState(false)

    const test = useTranslatedText(testEnabled ? SAMPLE_EN : null, { enabled: testEnabled })

    React.useEffect(() => setDraft(storedKey), [storedKey])

    const dirty = draft.trim() !== storedKey.trim()

    return (
        <div className="space-y-6 max-w-xl">
            <p className="text-sm text-[--muted] leading-relaxed">
                {t("settings.deepl.intro")}{" "}
                <a
                    href="https://www.deepl.com/pro-api"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-400 hover:underline"
                >
                    {t("settings.deepl.signup_link")}
                </a>
                {" "}{t("settings.deepl.intro_suffix")}
            </p>

            <div className="space-y-2">
                <label className="text-sm font-medium text-white block">
                    {t("settings.deepl.key_label")}
                </label>
                <div className="flex gap-2">
                    <TextInput
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx"
                        type="password"
                        leftIcon={<LuKeyRound />}
                        className="!text-white bg-white/5 border-white/10"
                    />
                    <Button
                        intent="primary"
                        onClick={() => setStoredKey(draft.trim())}
                        disabled={!dirty}
                    >
                        {t("common.save")}
                    </Button>
                </div>
                <p className="text-xs text-[--muted]">
                    {t("settings.deepl.key_storage_note")}
                </p>
            </div>

            {storedKey && (
                <div className="space-y-3 rounded-md p-4 bg-white/[0.03] border border-white/10">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-white">{t("settings.deepl.test_title")}</span>
                        <Button
                            size="sm"
                            intent="gray-subtle"
                            onClick={() => setTestEnabled(true)}
                            disabled={test.isTranslating}
                            loading={test.isTranslating}
                        >
                            {t("settings.deepl.test_button")}
                        </Button>
                    </div>
                    <p className="text-xs text-[--muted]">EN → {SAMPLE_EN}</p>
                    {testEnabled && (
                        <p className={test.error ? "text-xs text-red-300" : "text-sm text-white"}>
                            {test.error
                                ? t("settings.deepl.test_failed")
                                : test.text === SAMPLE_EN && !test.isTranslating
                                    ? "…"
                                    : test.text}
                        </p>
                    )}
                    {testEnabled && !test.isTranslating && !test.error && test.text !== SAMPLE_EN && (
                        <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                            <LuCheck />
                            <span>{t("settings.deepl.test_ok")}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
