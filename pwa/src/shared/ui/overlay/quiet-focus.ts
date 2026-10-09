import { useLayoutEffect, useState, type RefObject } from "react";
import { overlayOrigin } from "./origin";

/** What a dialog carries while its focus ring is held back; the rule is in `styles/overlay.scss`. */
export const QUIET_FOCUS = "data-quiet-focus";

/** A finger or a pen did what the reader just did, as far as the page saw. */
function openedByFinger(): boolean {
  const input = overlayOrigin()?.input;
  return input === "touch" || input === "pen";
}

/**
 * Hold a dialog's focus ring back under a finger.
 *
 * A dialog focuses a control as it opens, for a screen reader and for a
 * keyboard that may follow. Under a finger or a pen that is not a keyboard
 * position yet, but the browser rings it whenever the press had no click of its
 * own (a long press with the finger still down, a tap the page answered as the
 * finger lifted), so the ring waits for the first key. What opened the dialog
 * is read once, as it mounts: presses inside the open dialog are not what
 * opened it.
 *
 * The mark goes on the `<dialog>` itself, so whatever the dialog focuses later
 * (a pushed page, a row put back after a resize) is covered by the one rule.
 */
export function useQuietFocus(dialog: RefObject<HTMLDialogElement | null>): void {
  const [fingered] = useState(openedByFinger);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!fingered || !element) return;
    element.setAttribute(QUIET_FOCUS, "");
    const wake = () => element.removeAttribute(QUIET_FOCUS);
    document.addEventListener("keydown", wake, { capture: true, once: true });
    return () => {
      document.removeEventListener("keydown", wake, true);
      wake();
    };
  }, [dialog, fingered]);
}
