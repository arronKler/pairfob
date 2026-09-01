import { supportsWebgl2 } from "./full-terminal-renderer.ts";

export type FullTerminalXtermModule = typeof import("./full-terminal-xterm.ts");

let modulePromise: Promise<FullTerminalXtermModule> | null = null;
let preloadScheduled = false;
let capabilitySupported: boolean | null = null;

function saveDataEnabled(): boolean {
  return typeof navigator !== "undefined" &&
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

/** Cheap capability probe for automatic mode selection; explicit Terminal can still report its own error. */
export function fullTerminalSupported(): boolean {
  if (typeof document === "undefined" || saveDataEnabled()) return false;
  return terminalWebglSupported();
}

/** Share one released WebGL2 probe between preloading, Auto, and an explicit Terminal open. */
export function terminalWebglSupported(): boolean {
  if (typeof document === "undefined") return false;
  capabilitySupported ??= supportsWebgl2();
  return capabilitySupported;
}

export function loadFullTerminalXterm(): Promise<FullTerminalXtermModule> {
  if (modulePromise) return modulePromise;
  modulePromise = import("./full-terminal-xterm.ts").catch((error) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}

/** Warm the optional xterm chunk without delaying the pane's first paint. */
export function preloadFullTerminalXterm(): void {
  if (modulePromise || preloadScheduled || typeof document === "undefined") return;
  if (document.visibilityState === "hidden" || !fullTerminalSupported()) return;
  preloadScheduled = true;
  const load = () => {
    preloadScheduled = false;
    if (document.visibilityState === "hidden" || !fullTerminalSupported()) return;
    void loadFullTerminalXterm().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(load, { timeout: 1_500 });
    return;
  }
  window.setTimeout(load, 250);
}
