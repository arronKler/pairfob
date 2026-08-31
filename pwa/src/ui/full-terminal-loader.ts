export type FullTerminalXtermModule = typeof import("./full-terminal-xterm.ts");

let modulePromise: Promise<FullTerminalXtermModule> | null = null;
let preloadScheduled = false;

function saveDataEnabled(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
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
  if (modulePromise || preloadScheduled || document.visibilityState === "hidden" || saveDataEnabled()) return;
  preloadScheduled = true;
  const load = () => {
    preloadScheduled = false;
    if (document.visibilityState === "hidden" || saveDataEnabled()) return;
    void loadFullTerminalXterm().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(load, { timeout: 1_500 });
    return;
  }
  window.setTimeout(load, 250);
}
