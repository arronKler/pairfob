import { isPageZoomed } from "./lib/gesture-boundary";

export function isDesk(): boolean {
  return window.matchMedia("(min-width: 900px)").matches;
}

/**
 * Fit fullscreen shells above the software keyboard, including iOS focus pan.
 * Native page zoom changes the visual rectangle too: remove its scale and
 * preserve the existing focus offset so pinching does not reflow the shell.
 */
export type ViewportFrame = {
  top: number;
  height: number;
  kb: number;
};

export function visualViewportFrame(
  innerHeight: number,
  vv: { height: number; offsetTop: number; scale?: number } | null | undefined,
  previous?: ViewportFrame,
): ViewportFrame {
  if (!vv) {
    return { top: 0, height: Math.max(0, Math.round(innerHeight)), kb: 0 };
  }
  // Pinch changes the visible CSS rectangle, not the space available for layout.
  // Remove its scale and pan before interpreting the remainder as keyboard space.
  const scale = vv.scale && vv.scale > 0 ? vv.scale : 1;
  const height = Math.max(0, Math.round(vv.height > 0 ? vv.height * scale : innerHeight));
  // Keep an existing keyboard focus pan while zooming. Once keyboard space
  // changes, discard that offset rather than carrying it into the next layout.
  const zoomTop = previous?.height === height ? previous.top : 0;
  const top = Math.max(0, Math.round(scale > 1 ? zoomTop : vv.offsetTop));
  const kb = Math.max(0, Math.round(innerHeight - height - top));
  return { top, height, kb };
}

let viewportFrame: ViewportFrame | undefined;
let viewportWidth = 0;

export function applyVisualViewport(): ViewportFrame {
  const zoomed = isPageZoomed(document);
  document.documentElement.classList.toggle("page-zoomed", zoomed);
  if (!zoomed && document.body.classList.contains("lock")) window.scrollTo(0, 0);
  const frame = visualViewportFrame(
    window.innerHeight, window.visualViewport, viewportWidth === window.innerWidth ? viewportFrame : undefined,
  );
  viewportFrame = frame;
  viewportWidth = window.innerWidth;
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
  let height = applyVisualViewport().height;
  let width = window.innerWidth;
  const resized = (): void => {
    const frame = applyVisualViewport();
    const changed = frame.height !== height || window.innerWidth !== width;
    height = frame.height;
    width = window.innerWidth;
    if (changed) onResize();
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
