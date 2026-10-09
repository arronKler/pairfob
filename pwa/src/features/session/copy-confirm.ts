import { useCallback, useEffect, useState } from "react";

/**
 * A copy in the session is confirmed on the control that was pressed.
 *
 * A banner above the transcript or the buffer takes its own height from them
 * and pushes every line down for as long as it shows: the next press, aimed at
 * the block below or at the reply's own button, lands on whatever moved under
 * the pointer, and the clipboard keeps the first copy while the banner still
 * says "copied". The pressed control changes instead, where the reader is
 * looking, and nothing else moves. Each press confirms itself again.
 */

/** How long a pressed control reads as copied before it is itself again. */
export const COPIED_MS = 1600;

/**
 * The copied state of one control: `confirm(what)` starts it (again, when it is
 * already showing) and it ends by itself after `ms`.
 */
export function useCopied<What extends string = "done">(ms = COPIED_MS): [copied: What | null, confirm: (what: What) => void] {
  // A new object for every press, so a second press restarts the wait.
  const [shown, setShown] = useState<{ what: What } | null>(null);
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(null), ms);
    return () => window.clearTimeout(timer);
  }, [shown, ms]);
  const confirm = useCallback((what: What) => setShown({ what }), []);
  return [shown?.what ?? null, confirm];
}

const reverting = new WeakMap<HTMLElement, number>();

/**
 * The same for a button outside React (a code block's own, added to sanitized
 * HTML): its label reads `copied` for `ms`, at the width it already had so the
 * line beside it does not reflow, and `announce` is what a screen reader hears.
 */
export function confirmCopyOn(button: HTMLElement, label: string, copied: string, announce: string, ms = COPIED_MS): void {
  const pending = reverting.get(button);
  if (pending !== undefined) window.clearTimeout(pending);
  else button.style.minWidth = `${button.offsetWidth}px`;
  button.dataset.copied = "";
  button.textContent = copied;
  button.setAttribute("aria-label", announce);
  reverting.set(button, window.setTimeout(() => {
    reverting.delete(button);
    delete button.dataset.copied;
    button.textContent = label;
    button.removeAttribute("aria-label");
    button.style.minWidth = "";
  }, ms));
}
