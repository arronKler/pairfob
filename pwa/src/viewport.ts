export function isDesk(): boolean {
  return window.matchMedia("(min-width: 900px)").matches;
}

/**
 * Pin fullscreen shells to the visual viewport.
 *
 * iOS overlays the software keyboard instead of shrinking the layout viewport,
 * so `position:fixed; inset:0` stays behind it. `--kb` padding from
 * `innerHeight - vv.height - offsetTop` is 0 when Safari has already shrunk
 * `innerHeight` (or reports a pan) without moving fixed boxes. `offsetTop` and
 * `height` from visualViewport are the visible rectangle.
 */
export type ViewportFrame = {
  top: number;
  height: number;
  kb: number;
};

export function visualViewportFrame(
  innerHeight: number,
  vv: { height: number; offsetTop: number } | null | undefined,
): ViewportFrame {
  if (!vv) {
    return { top: 0, height: Math.max(0, Math.round(innerHeight)), kb: 0 };
  }
  const top = Math.max(0, Math.round(vv.offsetTop));
  const height = Math.max(0, Math.round(vv.height > 0 ? vv.height : innerHeight));
  const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
  return { top, height, kb };
}

export function applyVisualViewport(): ViewportFrame {
  if (document.body.classList.contains("lock")) window.scrollTo(0, 0);
  const frame = visualViewportFrame(window.innerHeight, window.visualViewport);
  const root = document.documentElement.style;
  root.setProperty("--vv-top", `${frame.top}px`);
  root.setProperty("--vv-height", `${frame.height}px`);
  root.setProperty("--kb", `${frame.kb}px`);
  return frame;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

let syncTimers: number[] = [];

function clearSyncTimers(): void {
  for (const id of syncTimers) window.clearTimeout(id);
  syncTimers = [];
}

/** iOS often applies the keyboard inset after focus, not on the first resize. */
export function scheduleVisualViewport(onResize?: () => void): void {
  const run = (): void => {
    applyVisualViewport();
    onResize?.();
  };
  run();
  requestAnimationFrame(run);
  clearSyncTimers();
  for (const delay of [80, 180, 360]) {
    syncTimers.push(window.setTimeout(run, delay));
  }
}

export function bindVisualViewport(onResize: () => void): void {
  const resized = (): void => {
    applyVisualViewport();
    onResize();
  };
  window.visualViewport?.addEventListener("resize", resized);
  window.visualViewport?.addEventListener("scroll", applyVisualViewport);
  window.addEventListener("resize", resized);
  document.addEventListener("focusin", (event) => {
    if (isEditableTarget(event.target)) scheduleVisualViewport(onResize);
  });
  document.addEventListener("focusout", (event) => {
    if (isEditableTarget(event.target)) scheduleVisualViewport(onResize);
  });
  applyVisualViewport();
}
