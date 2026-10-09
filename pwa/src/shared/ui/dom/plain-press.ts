/**
 * Which keys press a focused button or link.
 *
 * Enter and Space, plain. A browser also presses a button on Enter with any
 * modifier held, which nobody means: Shift+Enter is a line feed wherever text
 * is typed, and in the session it is the program's own line feed whatever has
 * focus. So a control keeps only its plain press, and Enter with a modifier
 * follows the rule of the surface the control sits in.
 *
 * `isPlainPress` is what a key router asks before leaving a key to the focused
 * control. A router that takes a modified Enter for itself also calls
 * `declineModifiedPress`, because routing the key elsewhere does not stop the
 * browser from pressing the button as well.
 */

/** A control that a press activates. */
const PRESSED = "button, a[href], summary, [role='button']";

function modified(event: KeyboardEvent): boolean {
  return event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
}

/** Enter or Space with no modifier: the press a focused control answers itself. */
export function isPlainPress(event: KeyboardEvent): boolean {
  return (event.key === "Enter" || event.key === " ") && !modified(event);
}

/**
 * Enter with a modifier on a control a press activates: cancel the browser's
 * activation, so the key is only what its router made of it. Returns whether
 * it was such a key. Space is left alone: with a modifier it presses nothing.
 */
export function declineModifiedPress(event: KeyboardEvent): boolean {
  const target = event.target;
  if (event.key !== "Enter" || !modified(event) || !(target instanceof HTMLElement) || !target.closest(PRESSED)) return false;
  event.preventDefault();
  return true;
}
