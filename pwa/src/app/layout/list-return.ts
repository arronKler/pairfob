import { tryAppRoot } from "../dom-root";

/**
 * A press this soon after the release that brought the list back was aimed at
 * what the list replaced: the second half of a double tap or a double click
 * (half a second is the usual system double-click interval). Nobody reads a
 * list and picks from it in that time.
 */
export const LIST_RETURN_SECOND_TAP_MS = 500;

/**
 * The list returning under a finger.
 *
 * In the desk's narrowest tier the board has the row to itself, and a tap on
 * one of its tiles opens the pane beside the list. The board opens it as the
 * finger lifts, so the list is back before the tap's own click arrives, and the
 * browser aims that click at whatever is under the finger by then: a row the
 * finger never touched, which would open a different session.
 *
 * A pointer click that lands in the list after a release made while the list
 * was off screen is therefore not a click on the list. That release is
 * remembered until the next press or key, or until it has stopped its one
 * click.
 *
 * A double tap goes one further: its second press comes down on the list
 * itself (the board's back control gives way to the computer title). A press
 * that starts within `LIST_RETURN_SECOND_TAP_MS` of such a release is not a
 * click on the list either. Only the clock bounds it, so a later, deliberate
 * tap is always the reader's; a key forgets both.
 */
export function guardListReturn(now: () => number = () => performance.now()): () => void {
  let releasedWithoutList = false;
  let releasedAt = Number.NEGATIVE_INFINITY;
  /** The press now down began inside the double-tap interval. */
  let secondTap = false;
  const onPress = (): void => {
    releasedWithoutList = false;
    secondTap = now() - releasedAt < LIST_RETURN_SECOND_TAP_MS;
  };
  const onKey = (): void => {
    releasedWithoutList = false;
    secondTap = false;
    releasedAt = Number.NEGATIVE_INFINITY;
  };
  const onRelease = (): void => {
    releasedWithoutList = tryAppRoot()?.classList.contains("rail-hidden") === true;
    if (releasedWithoutList) releasedAt = now();
  };
  const onClick = (event: MouseEvent): void => {
    // `detail` is 0 for a key press or a scripted click: neither follows a release.
    if (!(releasedWithoutList || secondTap) || event.detail === 0) return;
    if (!(event.target instanceof Element) || !event.target.closest(".rail")) return;
    releasedWithoutList = false;
    secondTap = false;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("pointerdown", onPress, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerup", onRelease, true);
  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("pointerdown", onPress, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerup", onRelease, true);
    document.removeEventListener("click", onClick, true);
  };
}
