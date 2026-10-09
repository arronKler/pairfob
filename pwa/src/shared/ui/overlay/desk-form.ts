import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isDesk } from "../dom/width-tier";
import { deskInput } from "./popover";

/**
 * The desk form of a dialog: the centred card a wide window draws, kept below
 * the roomy width when a mouse or the keyboard opened it beside the list. The
 * bottom sheet belongs to a finger there, and to every phone.
 *
 * The class is what the sheet rules step aside for (`overlay.scss`), and what
 * the drag gesture reads. The gesture that opened the dialog is read once, so a
 * later tap inside it changes nothing; the window is asked again every time it
 * is resized.
 */
export const DESK_FORM = "desk-form";

/** A dialog that is not a bottom sheet at any width: anchored, or the desk form. */
export const CARD = `.popover, .${DESK_FORM}`;

/**
 * Whether this dialog takes its desk form. A dialog a mouse or the keyboard
 * opened follows the window both ways: dragged down to the phone layout it is
 * handed to the sheet instead of closing a form the reader is filling in, and
 * widened again it is the card it would have been had it opened there, as it
 * already is past the roomy width. One a finger opened stays the sheet.
 */
export function useDeskForm(): boolean {
  const [asked] = useState(deskInput);
  const [desk, setDesk] = useState(() => asked && isDesk());
  useEffect(() => {
    if (!asked) return;
    const resized = () => setDesk(isDesk());
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, [asked]);
  return desk;
}

/** The dialog's class list with its presentation. */
export function dialogClass(className: string, deskForm: boolean): string {
  return deskForm ? `${className} ${DESK_FORM}` : className;
}

/**
 * What a control inside a dialog reads to know it is drawn in the desk form,
 * and what "Cancel" means there: step back from a page pushed inside the
 * dialog, else dismiss it. Null in a bottom sheet, which has its own bar, its
 * handle and the backdrop for that.
 */
export const DeskFormContext = createContext<{ cancel: () => void } | null>(null);

/** The enclosing desk form's cancel; null when the dialog is a sheet. */
export function useDeskCancel(): (() => void) | null {
  return useContext(DeskFormContext)?.cancel ?? null;
}

/** A dialog drawn for a mouse or the keyboard: the centred card, or the panel under its trigger. */
const DESK_DIALOG = `dialog.${DESK_FORM}, dialog.popover-panel`;
/** One of several alternatives the form submits with: a radio, or a row or chip marked as one. */
const CHOICE = "button[role='radio'], button[data-choice]";

/**
 * Enter in a desk form means "go", as it does in any form under a keyboard:
 * from a single-line field, and from a choice (a radio chip or tile; Space
 * only chooses it), which is chosen first so the form goes with what the
 * reader was on. A button that does something else keeps its own Enter, and so
 * does an IME's confirming one. The sheet is left alone: its Return belongs to
 * the on-screen keyboard's own "done".
 *
 * `submit` is read when the key has been handled, so it runs with the choice
 * just made.
 */
export function useDeskEnter(submit: () => void): (event: KeyboardEvent<HTMLElement>) => void {
  const latest = useRef(submit);
  latest.current = submit;
  return (event) => {
    const target = event.target;
    if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing || !(target instanceof HTMLElement)) return;
    if (!target.closest(DESK_DIALOG)) return;
    const choice = target.matches(CHOICE);
    if (!choice && !(target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (!choice) return latest.current();
    if (target.getAttribute("aria-checked") !== "true" && target.getAttribute("aria-pressed") !== "true") target.click();
    window.setTimeout(() => latest.current(), 0);
  };
}
