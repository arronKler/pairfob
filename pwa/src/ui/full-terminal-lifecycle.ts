/** Browser scheduling around the expensive xterm/WebGL mount lifecycle. */

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

/** Ignore ResizeObserver's initial delivery because the caller already fitted this size. */
export function observeHostResize(host: HTMLElement, resize: () => void): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  let width = host.clientWidth;
  let height = host.clientHeight;
  const observer = new ResizeObserver(() => {
    const nextWidth = host.clientWidth;
    const nextHeight = host.clientHeight;
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;
    resize();
  });
  observer.observe(host);
  return observer;
}
