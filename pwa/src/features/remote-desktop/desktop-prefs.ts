import { useSyncExternalStore } from "react";
import type { DesktopQuality } from "../../lib/protocol/remote-desktop";

export type DesktopMode = "control" | "view";
export type DesktopTouchMode = "trackpad" | "direct";

export type DesktopPrefs = {
  readonly defaultMode: DesktopMode;
  readonly defaultQuality: DesktopQuality;
  readonly defaultAudio: boolean;
  readonly touchMode: DesktopTouchMode;
};

export const DESKTOP_PREFS_KEY = "pairfob:desktopPrefs";

const DEFAULT_PREFS: DesktopPrefs = Object.freeze({
  defaultMode: "control",
  defaultQuality: "balanced",
  defaultAudio: false,
  touchMode: "trackpad",
});

function isQuality(value: unknown): value is DesktopQuality {
  return value === "balanced" || value === "detail" || value === "motion";
}

function parsePrefs(raw: string | null): DesktopPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopPrefs> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    return Object.freeze({
      defaultMode: parsed.defaultMode === "view" ? "view" : "control",
      defaultQuality: isQuality(parsed.defaultQuality) ? parsed.defaultQuality : "balanced",
      defaultAudio: typeof parsed.defaultAudio === "boolean" ? parsed.defaultAudio : false,
      touchMode: parsed.touchMode === "direct" ? "direct" : "trackpad",
    });
  } catch {
    return DEFAULT_PREFS;
  }
}

function readStoredPrefs(): DesktopPrefs {
  try {
    return parsePrefs(localStorage.getItem(DESKTOP_PREFS_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeStoredPrefs(prefs: DesktopPrefs): void {
  try {
    localStorage.setItem(DESKTOP_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode or storage quota */
  }
}

let cachedPrefs: DesktopPrefs = readStoredPrefs();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function updatePrefs(patch: Partial<DesktopPrefs>): void {
  const next: DesktopPrefs = Object.freeze({ ...cachedPrefs, ...patch });
  if (
    next.defaultMode === cachedPrefs.defaultMode
    && next.defaultQuality === cachedPrefs.defaultQuality
    && next.defaultAudio === cachedPrefs.defaultAudio
    && next.touchMode === cachedPrefs.touchMode
  ) return;
  cachedPrefs = next;
  writeStoredPrefs(next);
  notify();
}

export function getDesktopPrefs(): DesktopPrefs {
  const stored = readStoredPrefs();
  if (
    stored.defaultMode !== cachedPrefs.defaultMode
    || stored.defaultQuality !== cachedPrefs.defaultQuality
    || stored.defaultAudio !== cachedPrefs.defaultAudio
    || stored.touchMode !== cachedPrefs.touchMode
  ) {
    cachedPrefs = stored;
  }
  return cachedPrefs;
}

export function setDefaultMode(defaultMode: DesktopMode): void {
  updatePrefs({ defaultMode });
}

export function setDefaultQuality(defaultQuality: DesktopQuality): void {
  updatePrefs({ defaultQuality });
}

export function setDefaultAudio(defaultAudio: boolean): void {
  updatePrefs({ defaultAudio });
}

export function setTouchMode(touchMode: DesktopTouchMode): void {
  updatePrefs({ touchMode });
}

function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DESKTOP_PREFS_KEY) return;
    const prev = cachedPrefs;
    const next = getDesktopPrefs();
    if (next !== prev) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Reactive LocalStorage-backed remote desktop preferences. */
export function useDesktopPrefs(): DesktopPrefs {
  return useSyncExternalStore(subscribePrefs, getDesktopPrefs, () => DEFAULT_PREFS);
}
