import { useSyncExternalStore } from "react";
import { DESK_QUERY, ROOMY_QUERY, handheld, isDesk } from "../../shared/ui/dom/width-tier";

const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const COARSE_POINTER_QUERY = "(any-pointer: coarse)";

export type DesktopSurfaceMode = {
  readonly deskLayout: boolean;
  readonly phonePortrait: boolean;
  readonly phoneLandscape: boolean;
  readonly pointerFine: boolean;
  readonly hasTouch: boolean;
  readonly hardwareKeyboard: boolean;
  /** True when on-screen touch HUD / touchpad controls should be shown. */
  readonly touchUi: boolean;
};

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

let hwKeySeen = false;
const listeners = new Set<() => void>();

function notify(): void {
  cached = computeSurfaceMode();
  for (const listener of [...listeners]) listener();
}

function computeSurfaceMode(): DesktopSurfaceMode {
  if (typeof window === "undefined") {
    return Object.freeze({
      deskLayout: false,
      phonePortrait: true,
      phoneLandscape: false,
      pointerFine: false,
      hasTouch: false,
      hardwareKeyboard: false,
      touchUi: true,
    });
  }
  const desk = isDesk();
  const fine = matches(FINE_POINTER_QUERY);
  const coarse = matches(COARSE_POINTER_QUERY);
  const landscape = window.innerWidth > window.innerHeight;
  const isHandheld = handheld() || !desk;
  const phoneLandscape = !desk && isHandheld && landscape;
  const phonePortrait = !desk && !phoneLandscape;
  const hwKeyboard = fine || (hwKeySeen && desk);
  const touchUi = !(fine && hwKeyboard) && (coarse || !fine || !hwKeyboard);
  return Object.freeze({
    deskLayout: desk,
    phonePortrait,
    phoneLandscape,
    pointerFine: fine,
    hasTouch: coarse,
    hardwareKeyboard: hwKeyboard,
    touchUi,
  });
}

let cached: DesktopSurfaceMode = computeSurfaceMode();

const DEFAULT_SNAPSHOT: DesktopSurfaceMode = Object.freeze({
  deskLayout: false,
  phonePortrait: true,
  phoneLandscape: false,
  pointerFine: false,
  hasTouch: false,
  hardwareKeyboard: false,
  touchUi: true,
});

function getSnapshot(): DesktopSurfaceMode {
  const next = computeSurfaceMode();
  if (
    next.deskLayout === cached.deskLayout
    && next.phonePortrait === cached.phonePortrait
    && next.phoneLandscape === cached.phoneLandscape
    && next.pointerFine === cached.pointerFine
    && next.hasTouch === cached.hasTouch
    && next.hardwareKeyboard === cached.hardwareKeyboard
    && next.touchUi === cached.touchUi
  ) {
    return cached;
  }
  cached = next;
  return cached;
}

function isRealPhysicalKey(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || event.key === "Unidentified" || event.key === "Process") {
    return false;
  }
  if (typeof document !== "undefined" && document.documentElement.dataset.kb === "open") return false;
  const target = event.target instanceof Element ? event.target.closest("input, textarea, select, [contenteditable='true']") : null;
  if (target) {
    return event.metaKey || event.ctrlKey || event.altKey || event.key === "Escape" || event.key === "Tab" || /^F\d{1,2}$/.test(event.key);
  }
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") return () => { listeners.delete(listener); };
  const queries = [DESK_QUERY, ROOMY_QUERY, FINE_POINTER_QUERY, COARSE_POINTER_QUERY]
    .map(q => typeof window.matchMedia === "function" ? window.matchMedia(q) : null)
    .filter((m): m is MediaQueryList => m !== null);
  const onChange = () => notify();
  for (const mq of queries) mq.addEventListener?.("change", onChange);
  window.addEventListener("resize", onChange);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!hwKeySeen && isRealPhysicalKey(event)) {
      hwKeySeen = true;
      notify();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);

  const Observer = window.MutationObserver;
  const observer = Observer ? new Observer(() => {
    if (document.documentElement.dataset.kb === "open" && hwKeySeen) {
      hwKeySeen = false;
      notify();
    }
  }) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-kb"] });

  return () => {
    listeners.delete(listener);
    for (const mq of queries) mq.removeEventListener?.("change", onChange);
    window.removeEventListener("resize", onChange);
    document.removeEventListener("keydown", onKeyDown, true);
    observer?.disconnect();
  };
}

/** Width-tier and input-mode adaptation for Remote Desktop without importing app/. */
export function useDesktopSurfaceMode(): DesktopSurfaceMode {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_SNAPSHOT);
}
