import { useSyncExternalStore } from "react";
import { clearNotice } from "../../app/notices-store";
import { langPref, langRevision, setLangPref, subscribeLang, t, type LangPref } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";

/**
 * Language preference controls. Connected: a change persists the preference,
 * clears the current notice, and publishes the i18n revision so every mounted
 * copy re-renders through the language subscription — no global repaint.
 */

const LANG_OPTIONS = [
  { id: "auto", key: "settings.langAuto", compact: "chrome.langAuto" },
  { id: "zh", key: "settings.langZh", compact: "settings.langZh" },
  { id: "en", key: "settings.langEn", compact: "settings.langEn" },
] as const;

/** Re-render copy on the i18n revision (advances on every applied language action). */
function useLang(): void {
  useSyncExternalStore(subscribeLang, langRevision);
}

export function applyLanguage(next: LangPref): void {
  if (langPref() === next) return;
  setLangPref(next);
  clearNotice();
}

export function LanguageControl() {
  useLang();
  return <div className="seg" role="radiogroup" aria-label={t("settings.langAria")}>
    {LANG_OPTIONS.map(option => <Button key={option.id} role="radio" aria-checked={langPref() === option.id}
      className={`seg-item${langPref() === option.id ? " on" : ""}`} onClick={() => applyLanguage(option.id)}>
      {t(option.key)}
    </Button>)}
  </div>;
}

export function LanguageSelect() {
  useLang();
  return <select className="lang-select" aria-label={t("settings.langAria")} value={langPref()}
    onChange={event => applyLanguage(event.currentTarget.value === "en" || event.currentTarget.value === "zh" ? event.currentTarget.value : "auto")}>
    {LANG_OPTIONS.map(option => <option key={option.id} value={option.id}>{t(option.compact)}</option>)}
  </select>;
}