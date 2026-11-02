import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { pointerFine, usePointerFine } from "../../../app/input-mode";
import { isPageZoomed, PinchSteps, touchSpread } from "../../../lib/gesture-boundary";

/**
 * How a conversation reads: the size of the agent's words on this device, and
 * the two fingers that take it up or down. Kept apart from the diff's sizes
 * (`workspace/prefs`): a transcript is read at arm's length, where a phone
 * wants the size a diff would never use.
 *
 * Until the reader picks one the size follows the pointer, not the window: a
 * mouse reads at 14px, a finger at 16px, the same two sizes the stylesheet
 * falls back to. Once they pick, the choice is theirs on this device.
 */
export const CHAT_SIZES = [12.5, 14, 15.5, 17, 18.5, 20, 22] as const;
const CHAT_SIZE_KEY = "pairfob.chat.fontSize";
const listeners = new Set<() => void>();
const beforeListeners = new Set<() => void>();

function read(): number | null {
  try {
    const stored = Number(globalThis.localStorage?.getItem(CHAT_SIZE_KEY));
    return CHAT_SIZES.find((size) => size === stored) ?? null;
  } catch {
    return null;
  }
}

let chosen = read();

/** The size the stylesheet draws when the reader has picked none. */
export function autoChatSize(fine: boolean = pointerFine()): number {
  return fine ? 14 : 16;
}

/** The reader's own size in px; null while the automatic one applies. */
export function chatFontSize(): number | null {
  return chosen;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Hear just before the size changes, while the transcript is still drawn the
 * old way: the turn being read can be held where it is across the redraw.
 */
export function beforeChatReadingChange(listener: () => void): () => void {
  beforeListeners.add(listener);
  return () => { beforeListeners.delete(listener); };
}

export function setChatFontSize(next: number | null): void {
  const size = next === null ? null : CHAT_SIZES.find((step) => step === next) ?? null;
  if (size === chosen) return;
  for (const listener of beforeListeners) listener();
  chosen = size;
  try {
    if (size === null) globalThis.localStorage?.removeItem(CHAT_SIZE_KEY);
    else globalThis.localStorage?.setItem(CHAT_SIZE_KEY, String(size));
  } catch { /* keep the in-memory value */ }
  for (const listener of listeners) listener();
}

export function useChatFontSize(): number | null {
  return useSyncExternalStore(subscribe, chatFontSize, chatFontSize);
}

/** The size the transcript is drawn at now: the reader's, or the pointer's until they pick. */
export function useDrawnChatSize(): number {
  return drawnChatSize(useChatFontSize(), usePointerFine());
}

/** A size this close to another is the same size. */
const SAME_SIZE = 0.05;

/**
 * The steps from small to large: the reader's sizes, and the automatic one
 * where it is not one of them, so a step can always come back to it.
 */
function steps(auto: number): number[] {
  const sizes: number[] = [...CHAT_SIZES];
  if (!sizes.some((size) => Math.abs(size - auto) <= SAME_SIZE)) sizes.push(auto);
  return sizes.sort((a, b) => a - b);
}

function nextSize(direction: 1 | -1, auto: number): number | undefined {
  const from = chosen ?? auto;
  const sizes = steps(auto);
  return direction > 0
    ? sizes.find((size) => size > from + SAME_SIZE)
    : sizes.reverse().find((size) => size < from - SAME_SIZE);
}

export function canStepChatSize(direction: 1 | -1, auto: number): boolean {
  return nextSize(direction, auto) !== undefined;
}

/**
 * The step bigger (1) or smaller (-1) than the size drawn. Landing on the
 * automatic size gives the choice back to the pointer, so a tablet that gains
 * a mouse follows it again. False past either end.
 */
export function stepChatSize(direction: 1 | -1, auto: number): boolean {
  const next = nextSize(direction, auto);
  if (next === undefined) return false;
  setChatFontSize(Math.abs(next - auto) <= SAME_SIZE ? null : next);
  return true;
}

/** The number the sheet shows and the transcript is drawn at. */
export function drawnChatSize(chosenSize: number | null, fine: boolean): number {
  return chosenSize ?? autoChatSize(fine);
}

/** Tests: back to the automatic size, with nothing kept. */
export function resetChatFontSize(): void {
  chosen = null;
  try { globalThis.localStorage?.removeItem(CHAT_SIZE_KEY); } catch { /* ignore */ }
  for (const listener of listeners) listener();
}

/**
 * Two fingers on the transcript step its size instead of zooming the page. One
 * finger is left alone: the listener for a one-finger move never cancels it,
 * so scrolling stays native. A page the reader has already zoomed keeps its
 * own pinch, so it can always be zoomed back out over the transcript (the
 * stylesheet hands `pinch-zoom` back too, and `gesture-boundary` Safari's
 * gesture events).
 */
export function useChatPinch(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pinch = new PinchSteps();
    const zoomed = () => isPageZoomed(el.ownerDocument);
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 2 && !zoomed()) pinch.start(touchSpread(event.touches));
      else pinch.end();
    };
    const onMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinch.active) return;
      if (zoomed()) {
        pinch.end();
        return;
      }
      if (event.cancelable) event.preventDefault();
      const step = pinch.move(touchSpread(event.touches));
      if (step) stepChatSize(step, autoChatSize());
    };
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch.end();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref]);
}

/**
 * A place in the transcript that survives a redraw: the first turn at or below
 * the stream's top edge, and how far above that edge it starts. A size step
 * redraws every line at a new height; bringing this turn back to its offset
 * keeps the words the reader was on where they were.
 */
export type StreamAnchor = { el: HTMLElement; offset: number };

export function streamAnchor(stream: HTMLElement): StreamAnchor | null {
  const top = stream.getBoundingClientRect().top;
  for (const el of stream.querySelectorAll<HTMLElement>(".agent-stream-inner > *")) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top + 1) return { el, offset: rect.top - top };
  }
  return null;
}

/** Put `anchor` back at its offset after the transcript was drawn at another size. */
export function restoreStreamAnchor(stream: HTMLElement, anchor: StreamAnchor): void {
  if (!anchor.el.isConnected) return;
  const moved = anchor.el.getBoundingClientRect().top - stream.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(moved) >= 0.5) stream.scrollTop += moved;
}
