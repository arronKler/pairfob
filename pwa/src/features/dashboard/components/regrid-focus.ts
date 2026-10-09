import { useLayoutEffect, type RefObject } from "react";
import { isDesk } from "../../../shared/ui/dom/width-tier";
import { liveTrigger } from "../../../shared/ui/overlay/trigger";

/**
 * The keyboard's place in the list across the shell's regrid.
 *
 * Crossing the desk tier swaps the rail for the phone page or back. The list
 * is drawn again as other elements, the row that held focus leaves with the
 * old ones, and focus would fall to the body: the next Tab starts from the top
 * of the page. So the list that leaves hands the control it had focused to the
 * one that arrives, which focuses its own instance of it (`liveTrigger`: the
 * same kind of control for the same session or heading, or the only one of
 * that name).
 *
 * Only a regrid hands anything over. A list that leaves because the reader
 * went somewhere (a row opened its session on the phone) is not followed, and
 * neither is a control once the reader has focused anything else: a layout
 * with no list in it (the phone showing the open session) keeps the hand-over
 * for the rail's return only while focus is still nowhere.
 */
let handed: HTMLElement | null = null;
let forget = () => {};

function handOver(control: HTMLElement): void {
  forget();
  handed = control;
  const moved = () => forget();
  document.addEventListener("focusin", moved, true);
  forget = () => {
    document.removeEventListener("focusin", moved, true);
    handed = null;
    forget = () => {};
  };
}

export function useRegridFocus(root: RefObject<HTMLElement | null>, variant: "page" | "rail"): void {
  useLayoutEffect(() => {
    const from = handed;
    forget();
    const active = document.activeElement;
    // The browser scrolls the row into view if the new list drew it out of sight.
    if (from && (!active || active === document.body)) liveTrigger(from)?.focus();
    const list = root.current;
    return () => {
      const focused = document.activeElement;
      const regrid = isDesk() !== (variant === "rail");
      if (regrid && focused instanceof HTMLElement && list?.contains(focused)) handOver(focused);
    };
  }, [root, variant]);
}
