/**
 * The bar under a terminal wider than its column.
 *
 * Where the pan row has no scrollbar (beside the list, or under a mouse; see
 * the style sheet) this is what says the terminal continues to the side and
 * where the visible part sits. It lies over the host's bottom edge, so showing
 * and hiding it never changes the room the terminal is fitted to. Dragging it
 * pans; the wheel does the rest (`bindHostScroll`).
 */

/** Less overflow than this is a rounding remainder, not columns out of view. */
const MIN_OVERFLOW_PX = 2;

const syncs = new WeakMap<HTMLElement, () => void>();

/**
 * Read the overflow again after a fit. The grid xterm draws can change width
 * inside a pan row and a canvas that kept theirs (a window narrowed onto a grid
 * that is refitted a moment later), and neither box says so.
 */
export function syncPanBar(host: HTMLElement): void {
  const pan = host.querySelector<HTMLElement>(".full-terminal-pan");
  if (pan) syncs.get(pan)?.();
}

export function bindPanBar(bar: HTMLElement, pan: HTMLElement): () => void {
  const thumb = bar.firstElementChild as HTMLElement | null;
  if (!thumb) return () => undefined;
  let drag: { pointerId: number; grab: number } | null = null;
  /** xterm's own box, the one that overflows. It arrives with the renderer and leaves with it. */
  let screen: Element | null = null;

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => sync());

  const sync = (): void => {
    const drawn = pan.querySelector(".xterm-screen");
    if (drawn !== screen) {
      if (screen) observer?.unobserve(screen);
      screen = drawn;
      if (screen) observer?.observe(screen);
    }
    const overflow = pan.scrollWidth - pan.clientWidth;
    const hidden = overflow < MIN_OVERFLOW_PX;
    if (bar.hidden !== hidden) bar.hidden = hidden;
    if (hidden) return;
    thumb.style.width = `${(pan.clientWidth / pan.scrollWidth) * 100}%`;
    thumb.style.left = `${(pan.scrollLeft / pan.scrollWidth) * 100}%`;
  };

  const panTo = (clientX: number, grab: number): void => {
    const track = bar.getBoundingClientRect();
    const travel = track.width - thumb.getBoundingClientRect().width;
    if (!(travel > 0)) return;
    const ratio = Math.max(0, Math.min(1, (clientX - track.left - grab) / travel));
    pan.scrollLeft = ratio * (pan.scrollWidth - pan.clientWidth);
  };

  const onDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    // The press belongs to the bar: it must not start a terminal gesture, take
    // focus from the field, or reach xterm as a click.
    event.preventDefault();
    event.stopPropagation();
    const box = thumb.getBoundingClientRect();
    let grab = event.clientX - box.left;
    if (grab < 0 || grab > box.width) {
      // A press beside the thumb brings its middle under the pointer.
      grab = box.width / 2;
      panTo(event.clientX, grab);
    }
    drag = { pointerId: event.pointerId, grab };
    bar.classList.add("is-dragging");
    try {
      bar.setPointerCapture?.(event.pointerId);
    } catch {
      // A synthetic or already released pointer cannot be captured; moves over the bar still pan.
    }
  };
  const onMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    panTo(event.clientX, drag.grab);
  };
  const onEnd = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    bar.classList.remove("is-dragging");
  };
  const keep = (event: Event): void => { event.stopPropagation(); };

  observer?.observe(pan);
  const canvas = pan.firstElementChild;
  if (canvas) observer?.observe(canvas);
  pan.addEventListener("scroll", sync, { passive: true });
  bar.addEventListener("pointerdown", onDown);
  bar.addEventListener("pointermove", onMove);
  bar.addEventListener("pointerup", onEnd);
  bar.addEventListener("pointercancel", onEnd);
  bar.addEventListener("lostpointercapture", onEnd);
  bar.addEventListener("touchstart", keep, { passive: true });
  bar.addEventListener("mousedown", keep);
  syncs.set(pan, sync);
  sync();
  return () => {
    syncs.delete(pan);
    observer?.disconnect();
    pan.removeEventListener("scroll", sync);
    bar.removeEventListener("pointerdown", onDown);
    bar.removeEventListener("pointermove", onMove);
    bar.removeEventListener("pointerup", onEnd);
    bar.removeEventListener("pointercancel", onEnd);
    bar.removeEventListener("lostpointercapture", onEnd);
    bar.removeEventListener("touchstart", keep);
    bar.removeEventListener("mousedown", keep);
    bar.classList.remove("is-dragging");
  };
}
