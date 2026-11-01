import { prefersReducedMotion } from "../../../shared/ui/dom/motion";

/**
 * The glide to the latest turn after a send.
 *
 * A reader who was at the tail when they sent stays in one conversation: the
 * transcript scrolls the new prompt in instead of being replaced by a frame
 * that already has it. While that scroll runs the stream is short of its tail
 * by construction, and everything that asks "is the reader at the tail" would
 * read it as the reader having left: the follow would drop, the next poll would
 * keep the old place and the prompt would stop halfway. So the glide is a
 * state the stream's readers can ask about, and anything that pins the tail
 * meanwhile retargets it instead of cutting it short with a jump.
 *
 * The reader's own scroll ends it at once: they are where they chose to be.
 */

/** A browser's smooth scroll states no length; this long without a scroll event, it stopped short. */
const GLIDE_LIMIT_MS = 1200;

let glide: { stream: HTMLElement; end: () => void; target: number } | null = null;
const listeners = new Set<() => void>();
/** Where the app itself last put each stream: a box change after it moved the tail, not the reader. */
const pinnedTops = new WeakMap<HTMLElement, number>();
const inputWatched = new WeakSet<HTMLElement>();

/** The reader's own input moves the stream: whatever the app pinned is no longer where they are. */
function watchInput(stream: HTMLElement): void {
  if (inputWatched.has(stream)) return;
  inputWatched.add(stream);
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    stream.addEventListener(type, () => { pinnedTops.delete(stream); }, { passive: true });
  }
}

function announce(): void {
  for (const listener of listeners) listener();
}

/** A glide starts and ends; the chat's header keeps its place while one runs (`agent-chat`). */
export function subscribeTailGlide(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Where the tail sits in the scroller: the box's height moves it as much as the transcript does. */
function tailTop(stream: HTMLElement): number {
  return stream.scrollHeight - stream.clientHeight;
}

/** True while `stream` is on its way to the tail by `glideToTail`. */
export function glidingToTail(stream: HTMLElement | null): boolean {
  return glide !== null && glide.stream === stream;
}

export function endTailGlide(): void {
  glide?.end();
}

/**
 * The stream sits where the app pinned it. A scroll event there is the pin's,
 * not the reader's, so the box moving under them is not the reader leaving.
 */
export function pinnedTail(stream: HTMLElement): boolean {
  const top = pinnedTops.get(stream);
  return top !== undefined && Math.abs(stream.scrollTop - top) < 1;
}

function begin(stream: HTMLElement): void {
  glide?.end();
  const bound = new AbortController();
  let timer = 0;
  const end = (): void => {
    window.clearTimeout(timer);
    bound.abort();
    if (glide?.stream === stream) {
      glide = null;
      announce();
    }
  };
  // A long trip is not a stuck one: the limit restarts while the stream keeps moving.
  const arm = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => end(), GLIDE_LIMIT_MS);
  };
  const options = { signal: bound.signal, passive: true };
  stream.addEventListener("scrollend", end, options);
  // For an engine without `scrollend`: arrived is over. Not sooner, or a pin would jump the last of the way.
  stream.addEventListener("scroll", () => {
    if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 1) end();
    else arm();
  }, options);
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) stream.addEventListener(type, end, options);
  arm();
  glide = { stream, end, target: -1 };
  announce();
}

/**
 * Scroll `stream` to its tail as one move. Under reduced motion, or where the
 * engine cannot scroll smoothly, it is the jump it always was.
 */
export function glideToTail(stream: HTMLElement): void {
  if (prefersReducedMotion() || typeof stream.scrollTo !== "function") {
    endTailGlide();
    pinTail(stream);
    return;
  }
  if (!glidingToTail(stream)) begin(stream);
  if (glide) glide.target = tailTop(stream);
  stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
  // Nothing to travel (or an engine that moved at once): there is no glide to protect.
  if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 1) endTailGlide();
}

/**
 * Pin `stream` to its tail: at once, or through the glide already under way.
 * A glide is only sent again when the tail itself moved: starting the same
 * scroll over makes the engine ease in again, and the move would stutter.
 */
export function pinTail(stream: HTMLElement): void {
  if (glidingToTail(stream)) {
    if (glide?.target !== tailTop(stream)) glideToTail(stream);
    return;
  }
  stream.scrollTop = stream.scrollHeight;
  pinnedTops.set(stream, stream.scrollTop);
  watchInput(stream);
}
