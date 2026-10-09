/**
 * The tail of a double tap on a back control.
 *
 * Going back swaps the screen under the finger, and a tap that was doubled by
 * accident comes down again at the same spot on whatever the screen before
 * shows there: its title, which opens a menu, or its own back control, which
 * leaves a second screen. Every back control arms this guard as it is pressed
 * (`BackButton`), so the rule lives in one place for every screen.
 *
 * A press is such a tail when it begins within `BACK_SECOND_TAP_MS` of the back
 * press and within `BACK_SECOND_TAP_PX` of it: nobody reads a screen and picks
 * from it in that time, and a double tap does not travel. Its click goes
 * nowhere, and so does a third tap's. A press a moment later, a press anywhere
 * else and every key are the reader's own, for a finger and a mouse alike.
 *
 * Not every control waits for a click. A key of the session's key row is sent
 * as it is pressed, and the board reads its own taps from the pointer, so the
 * tail's press is kept from everything below the document as well as its
 * click. The document's own listeners (this guard, the page's memory of the
 * last gesture) still hear it.
 */

/** Half a second is the usual system double-click interval (see `app/layout/list-return.ts`). */
export const BACK_SECOND_TAP_MS = 500;
/** One touch target: a double tap lands on itself, a deliberate next tap is somewhere else. */
export const BACK_SECOND_TAP_PX = 44;

/** Only the latest back press is ever followed. */
let disarm: (() => void) | null = null;

/**
 * Follow the back press made at `at`. `now` is injectable so a test can tell a
 * double tap from a deliberate one by moving a clock.
 */
export function guardBackTap(
  doc: Document,
  at: { x: number; y: number },
  now: () => number = () => performance.now(),
): void {
  disarm?.();
  const pressedAt = now();
  /** The press now down is a tail of the back press: its click is not a click. */
  let tail = false;
  const lapse = setTimeout(() => { if (!tail) cleanup(); }, BACK_SECOND_TAP_MS);
  const cleanup = (): void => {
    clearTimeout(lapse);
    doc.removeEventListener("pointerdown", onPress, true);
    doc.removeEventListener("pointercancel", cleanup, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", cleanup, true);
    if (disarm === cleanup) disarm = null;
  };
  const onPress = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    tail = now() - pressedAt < BACK_SECOND_TAP_MS
      && Math.hypot(event.clientX - at.x, event.clientY - at.y) <= BACK_SECOND_TAP_PX;
    // Later or elsewhere: the reader's own press, and nothing is left to guard.
    if (!tail) { cleanup(); return; }
    // Captured at the document, before any control: what acts on the press itself never sees this one.
    event.stopPropagation();
    event.preventDefault();
  };
  const onClick = (event: MouseEvent): void => {
    // `detail` is 0 for a key press or a scripted click: neither is a tap.
    if (!tail || event.detail === 0) return;
    tail = false;
    event.preventDefault();
    event.stopImmediatePropagation();
    // A tap that outlived the interval was the last one that could follow.
    if (now() - pressedAt >= BACK_SECOND_TAP_MS) cleanup();
  };
  doc.addEventListener("pointerdown", onPress, true);
  doc.addEventListener("pointercancel", cleanup, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", cleanup, true);
  disarm = cleanup;
}
