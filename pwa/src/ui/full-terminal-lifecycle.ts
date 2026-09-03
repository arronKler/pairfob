/** Browser scheduling around the expensive xterm/WebGL mount lifecycle. */

const HEIGHT_RESIZE_SETTLE_MS = 120;

/** Let the lightweight terminal shell paint before constructing WebGL. */
export function afterNextPaint(run: () => void): () => void {
  let cancelled = false;
  let frame = 0;
  let timer = 0;
  const queueTask = () => {
    if (cancelled) return;
    timer = window.setTimeout(() => {
      if (!cancelled) run();
    }, 0);
  };
  if (document.visibilityState === "hidden") queueTask();
  else frame = window.requestAnimationFrame(queueTask);
  return () => {
    cancelled = true;
    if (frame) window.cancelAnimationFrame(frame);
    if (timer) window.clearTimeout(timer);
  };
}

/**
 * Ignore the initial delivery and coalesce height-only changes while a phone's
 * software keyboard animates. The shell can still follow the visual viewport,
 * but xterm only clears, fits, and repaints once the available height settles.
 */
export function observeHostResize(
  host: HTMLElement,
  resize: () => void,
  options: { settleHeight?: boolean } = {},
): { disconnect: () => void } | null {
  if (typeof ResizeObserver === "undefined") return null;
  let width = host.clientWidth;
  let height = host.clientHeight;
  let settleTimer = 0;
  let active = true;
  const clearSettle = (): void => {
    window.clearTimeout(settleTimer);
    settleTimer = 0;
  };
  const observer = new ResizeObserver(() => {
    const nextWidth = host.clientWidth;
    const nextHeight = host.clientHeight;
    if (nextWidth === width && nextHeight === height) return;
    const widthChanged = nextWidth !== width;
    width = nextWidth;
    height = nextHeight;
    clearSettle();
    if (widthChanged || options.settleHeight === false) {
      resize();
      return;
    }
    settleTimer = window.setTimeout(() => {
      settleTimer = 0;
      if (active) resize();
    }, HEIGHT_RESIZE_SETTLE_MS);
  });
  observer.observe(host);
  return {
    disconnect() {
      active = false;
      clearSettle();
      observer.disconnect();
    },
  };
}
