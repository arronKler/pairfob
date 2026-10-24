import { SegmentedControl, SegmentedOption } from "../../shared/ui/primitives";
import { useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { setThemePref, subscribeTheme, themePref, themeRevision, type ThemePref } from "../../lib/theme";

/**
 * Appearance controls. A change writes the root's `data-theme` at once — the
 * tokens themselves carry both palettes, so nothing repaints beyond the colours
 * they resolve — then publishes the theme revision so every mounted copy shows
 * the new side.
 */

const THEME_OPTIONS = [
  { id: "auto", key: "settings.themeAuto", compact: "chrome.themeAuto" },
  { id: "light", key: "settings.themeLight", compact: "settings.themeLight" },
  { id: "dark", key: "settings.themeDark", compact: "settings.themeDark" },
] as const;

export function useTheme(): void {
  useSyncExternalStore(subscribeTheme, themeRevision);
}

/** `children` is what the bar draws under its options (the settings bar's thumb). */
export function ThemeControl({ className, children }: { className?: string; children?: ReactNode }) {
  useTheme();
  return <SegmentedControl className={className} aria-label={t("settings.themeAria")}>
    {children}
    {THEME_OPTIONS.map(option => <SegmentedOption key={option.id} selected={themePref() === option.id}
      onClick={() => setThemePref(option.id as ThemePref)}>
      {t(option.key)}
    </SegmentedOption>)}
  </SegmentedControl>;
}

export function ThemeSelect() {
  useTheme();
  return <select className="lang-select" aria-label={t("settings.themeAria")} value={themePref()}
    onChange={event => {
      const value = event.currentTarget.value;
      setThemePref(value === "light" || value === "dark" ? value : "auto");
    }}>
    {THEME_OPTIONS.map(option => <option key={option.id} value={option.id}>{t(option.compact)}</option>)}
  </select>;
}
