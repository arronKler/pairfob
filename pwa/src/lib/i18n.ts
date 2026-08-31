/** Shared with the marketing site: pairfob_lang=en|zh. Missing key means follow the browser. */

export type Lang = "en" | "zh";
export type LangPref = "auto" | Lang;

export const LANG_KEY = "pairfob_lang";
const YEAR = 31_536_000;

import { en } from "./i18n-en.ts";
import { zh } from "./i18n-zh.ts";

export type CopyKey = keyof typeof zh;

/** Tests skip `initI18n`; production calls it first. Default matches the previous PWA. */
let current: Lang = "zh";

function readStored(): Lang | null {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    /* private mode */
  }
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|; )pairfob_lang=(en|zh)(?:;|$)/);
  return match ? (match[1] as Lang) : null;
}

export function detectLang(): Lang {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const list =
    nav && nav.languages && nav.languages.length ? nav.languages : [nav?.language || ""];
  for (const item of list) {
    const tag = String(item || "").toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function langPref(): LangPref {
  return readStored() ?? "auto";
}

export function lang(): Lang {
  return current;
}

export function locale(): string {
  return current === "zh" ? "zh-CN" : "en";
}

function persist(value: Lang | null): void {
  try {
    if (value) localStorage.setItem(LANG_KEY, value);
    else localStorage.removeItem(LANG_KEY);
  } catch {
    /* private mode */
  }
  if (typeof document === "undefined") return;
  if (value) {
    document.cookie = `${LANG_KEY}=${value};path=/;max-age=${YEAR};SameSite=Lax`;
  } else {
    document.cookie = `${LANG_KEY}=;path=/;max-age=0;SameSite=Lax`;
  }
}

export function applyDocumentLang(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale();
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute("content", t("meta.description"));
}

export function setLang(next: Lang): Lang {
  current = next;
  applyDocumentLang();
  return current;
}

/** `auto` follows the browser and clears a stored choice. */
export function setLangPref(pref: LangPref): Lang {
  if (pref === "auto") {
    persist(null);
    return setLang(detectLang());
  }
  persist(pref);
  return setLang(pref);
}

export function initI18n(): Lang {
  const stored = readStored();
  return setLang(stored ?? detectLang());
}

function table(): Record<CopyKey, string> {
  return current === "zh" ? zh : en;
}

export function hasCopy(key: string): key is CopyKey {
  return key in zh;
}

export function t(key: CopyKey, vars?: Record<string, string | number>): string {
  let text: string = table()[key] ?? zh[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function copyKeys(): CopyKey[] {
  return Object.keys(zh) as CopyKey[];
}
