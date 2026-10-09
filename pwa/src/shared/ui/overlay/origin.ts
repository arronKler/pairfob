/**
 * The gesture that asks for an overlay.
 *
 * A menu is a popover for a mouse and a bottom sheet for a finger, and one
 * layout serves both: a landscape tablet is wide and touched. So presentation
 * follows the input that opened it, never the viewport alone. Most menus open
 * several calls away from their event (action ports, page bridges, a follow-up
 * after an await), so the page remembers its latest press or key instead of
 * every caller threading an event through.
 *
 * Nothing is remembered until the page binds the listeners: an origin kept by
 * one menu alone would go stale and misplace the next. Unbound, every overlay
 * is the sheet it always was.
 */
export type OverlayInput = "mouse" | "touch" | "pen" | "key";

export type OverlayOrigin = {
  input: OverlayInput;
  /** What was pressed, or what held focus for a key. */
  target: Element | null;
  x: number;
  y: number;
  /** A context click: the menu belongs at the pointer, not under the element. */
  atPointer: boolean;
};

let latest: OverlayOrigin | null = null;
let bound = 0;

export function overlayOrigin(): OverlayOrigin | null {
  return latest;
}

/** Refine what the page saw: a held press turns out to be a menu request. */
export function noteOverlayOrigin(origin: OverlayOrigin): void {
  if (bound) latest = origin;
}

function elementOf(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function" ? target as Element : null;
}

function inputOf(pointerType: string): OverlayInput {
  return pointerType === "touch" || pointerType === "pen" ? pointerType : "mouse";
}

export function pointerOrigin(event: PointerEvent): OverlayOrigin {
  const input = inputOf(event.pointerType);
  return { input, target: elementOf(event.target), x: event.clientX, y: event.clientY, atPointer: input === "mouse" && event.button === 2 };
}

/** The secondary mouse button, the only one a context click is made with. */
const SECONDARY = 2;

/**
 * A context-menu request. Only some engines put a pointer type on it, so an
 * untyped one belongs to whatever input came last.
 *
 * The context-menu key and Shift+F10 raise the same event, and an engine that
 * types it calls it a mouse's, placed inside the focused control. It carries no
 * mouse button though, and the key that asked was the last thing the page saw:
 * such a request stays the key's, so its menu hangs from the focused control
 * instead of opening at a point nobody pointed at.
 */
export function contextOrigin(event: MouseEvent): OverlayOrigin {
  const typed = (event as Partial<PointerEvent>).pointerType;
  const keyed = latest?.input === "key" && event.button !== SECONDARY;
  const input = keyed ? "key" : typed ? inputOf(typed) : latest?.input ?? "mouse";
  return { input, target: elementOf(event.target), x: event.clientX, y: event.clientY, atPointer: input === "mouse" };
}

/** One capture listener set for the page lifetime; release forgets the gesture. */
export function bindOverlayOrigin(doc: Document): () => void {
  const lifetime = new AbortController();
  bound += 1;
  const options = { capture: true, passive: true, signal: lifetime.signal };
  doc.addEventListener("pointerdown", (event) => { latest = pointerOrigin(event); }, options);
  doc.addEventListener("contextmenu", (event) => { latest = contextOrigin(event); }, options);
  doc.addEventListener("keydown", () => {
    latest = { input: "key", target: doc.activeElement, x: 0, y: 0, atPointer: false };
  }, options);
  return () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    bound -= 1;
    latest = null;
  };
}
