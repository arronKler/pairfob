import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Which way a strip of thumbnails continues past its box.
 *
 * The strip scrolls sideways and hides its scrollbar, and the thumbnails are a
 * fixed size: a column can end exactly on the edge of one, with the next
 * wholly out of sight and nothing to say it is there (a paused file waiting
 * for "Resume", at 744px). So the strip is told where it continues
 * (`data-more`: "start", "end" or "both") and the style sheet fades that edge.
 */
export type StripMore = "start" | "end" | "both" | null;

/** A scroll position within a pixel of an end is at it: fractional widths never quite land. */
export function stripMore(box: { scrollLeft: number; scrollWidth: number; clientWidth: number }): StripMore {
  const before = Math.abs(box.scrollLeft) > 1;
  const after = box.scrollWidth - box.clientWidth - Math.abs(box.scrollLeft) > 1;
  return before && after ? "both" : before ? "start" : after ? "end" : null;
}

function sync(element: HTMLElement): void {
  const more = stripMore(element);
  if (more) element.dataset.more = more;
  else delete element.dataset.more;
}

function watch(element: HTMLElement): () => void {
  const onChange = (): void => sync(element);
  element.addEventListener("scroll", onChange, { passive: true });
  const Observer = element.ownerDocument.defaultView?.ResizeObserver;
  const observer = Observer ? new Observer(onChange) : null;
  observer?.observe(element);
  return () => {
    element.removeEventListener("scroll", onChange);
    observer?.disconnect();
  };
}

/**
 * Keep `data-more` on the strip true to where it is scrolled, how wide it is
 * and what it holds. What it holds changes only with a render of its owner
 * (a file added, the small thumbnails beside an open keyboard), so every
 * render measures again. The strip comes and goes with the tray's content, so
 * the watch follows the node that is mounted.
 */
export function useStripOverflow(strip: RefObject<HTMLElement | null>): void {
  const watched = useRef<{ element: HTMLElement; release: () => void } | null>(null);
  useLayoutEffect(() => {
    const element = strip.current;
    if (watched.current && watched.current.element !== element) {
      watched.current.release();
      watched.current = null;
    }
    if (!element) return;
    watched.current ??= { element, release: watch(element) };
    sync(element);
  });
  useLayoutEffect(() => () => {
    watched.current?.release();
    watched.current = null;
  }, []);
}
