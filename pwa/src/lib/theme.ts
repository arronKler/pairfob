/**
 * Light or dark, chosen by the reader or followed from the system. The tokens
 * carry both palettes; this module only decides which one a document wears, and
 * writes the choice where a reload can find it. Nothing here paints: the root's
 * `data-theme` attribute is the whole switch, so a change is one attribute and
 * every token-derived colour follows in the same frame.
 */

export type ThemePref = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

const THEME_KEY = "pairfob_theme";
const YEAR = 60 * 60 * 24 * 365;

let listeners: Set<() => void> | null = null;
let revision = 0;

function notify(): void {
  revision += 1;
  if (!listeners?.size) return;
  for (const listener of [...listeners]) listener();
}

function systemTheme(): Theme {
  if (typeof matchMedia !== "function") return "dark";
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readStored(): ThemePref | null {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "auto" || stored === "light" || stored === "dark") return stored;
  } catch {
    /* private mode */
  }
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|; )pairfob_theme=(auto|light|dark)(?:;|$)/);
  return match ? (match[1] as ThemePref) : null;
}

export function themePref(): ThemePref {
  return readStored() ?? "auto";
}

/** What the document is wearing now, system setting included. */
export function theme(): Theme {
  const pref = themePref();
  return pref === "auto" ? systemTheme() : pref;
}

function persist(value: ThemePref | null): void {
  try {
    if (value && value !== "auto") localStorage.setItem(THEME_KEY, value);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* private mode */
  }
  if (typeof document === "undefined") return;
  document.cookie = value && value !== "auto"
    ? `${THEME_KEY}=${value};path=/;max-age=${YEAR};SameSite=Lax`
    : `${THEME_KEY}=;path=/;max-age=0;SameSite=Lax`;
}

/**
 * Write the attribute the tokens read. `auto` removes it, so the media query
 * decides and a reader who later changes their system setting follows it.
 */
const CHROME: Record<Theme, string> = { light: "#f5f6f8", dark: "#0a0c10" };

/** The side a `theme-color` meta is declared for, or null when it names none. */
function metaSide(meta: HTMLMetaElement): Theme | null {
  const media = meta.getAttribute("media") || "";
  if (media.includes("prefers-color-scheme: light")) return "light";
  if (media.includes("prefers-color-scheme: dark")) return "dark";
  return null;
}

export function applyDocumentTheme(): void {
  if (typeof document === "undefined") return;
  const pref = themePref();
  const root = document.documentElement;
  if (pref === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = pref;
  // The browser's own chrome (address bar, PWA status bar) follows the palette.
  // Following the system, each meta keeps the value its own media query declares,
  // so the browser picks per scheme with no script. An explicit choice outranks
  // the system, so every meta is set to the chosen side; returning to auto puts
  // each one back, or a stale manual value would survive the switch.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const side = metaSide(meta);
    if (pref === "auto") meta.content = CHROME[side ?? theme()];
    else meta.content = CHROME[pref];
  }
}

export function setThemePref(next: ThemePref): void {
  if (themePref() === next) return;
  persist(next);
  applyDocumentTheme();
  notify();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners ??= new Set();
  listeners.add(listener);
  // A system change only matters while the reader follows the system.
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
  const onSystem = () => {
    if (themePref() !== "auto") return;
    applyDocumentTheme();
    notify();
  };
  media?.addEventListener?.("change", onSystem);
  return () => {
    listeners?.delete(listener);
    media?.removeEventListener?.("change", onSystem);
  };
}

export function themeRevision(): number {
  return revision;
}
