import { useLayoutEffect, useRef, type RefObject } from "react";
import { useDeskForm } from "./desk-form";
import type { EscapeSteps } from "./escape-steps";
import { useQuietFocus } from "./quiet-focus";
import { bindSheetDrag } from "./sheet-drag";
import { trapTab } from "./tab-stops";
import { followTrigger } from "./trigger";

type ElementRef<T> = RefObject<T | null>;
type DialogLifecycle = {
  dialog: ElementRef<HTMLDialogElement>;
  onDismiss: () => void;
  onClose: () => void;
  /** Escape; defaults to dismiss. A stacked sheet steps back a page instead. */
  onCancel?: () => void;
  /** Steps taken inside the dialog that Escape undoes first, latest first (`escape-steps.ts`). */
  steps?: EscapeSteps;
  focus?: () => void;
  restoreFocus?: boolean;
  cancelGuardMs?: number;
  /** False keeps the dialog open on a backdrop tap (editors with a draft). */
  backdropDismiss?: boolean;
  sheet?: { form: ElementRef<HTMLFormElement>; scroller: ElementRef<HTMLElement> };
  /** Two sheet heights; read through the latest callbacks so the binding stays put. */
  detents?: { expanded(): boolean; set(expanded: boolean): void };
};

/**
 * Native dialog ownership shared by promise dialogs and state-controlled portals.
 *
 * Returns whether the dialog takes its desk form (`useDeskForm`), which the
 * owner draws with `dialogClass`: every dialog passes through here, so each one
 * follows the gesture that opened it without deciding anything of its own. The
 * same gesture decides whether the control it focuses shows a keyboard ring
 * (`useQuietFocus`).
 *
 * Tab stays inside the open dialog (`trapTab`). The key is watched on the
 * document, because focus that rests on nothing never passes a key through the
 * dialog, and only the dialog on top answers.
 */
export function useDialogLifecycle({ dialog, sheet, restoreFocus = false, cancelGuardMs = 400, backdropDismiss = true, ...callbacks }: DialogLifecycle): boolean {
  const deskForm = useDeskForm();
  // Declared before the effect that shows and focuses, so the dialog is marked by then.
  useQuietFocus(dialog);
  const expandable = !!callbacks.detents;
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const form = sheet?.form;
  const scroller = sheet?.scroller;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const origin = restoreFocus ? followTrigger(document.activeElement instanceof HTMLElement ? document.activeElement : null) : null;
    const openedAt = performance.now();
    const dismiss = () => latest.current.onDismiss();
    // A close request does not say what asked for it: Escape pressed while
    // focus rests on nothing reaches the dialog only as this request, like a
    // phone's system back. The key is told apart by being down.
    let escapeDown = false;
    const track = (event: KeyboardEvent) => { if (event.key === "Escape") escapeDown = event.type === "keydown"; };
    const cancel = (event: Event) => {
      event.preventDefault();
      if (escapeDown && latest.current.steps?.undo()) return;
      if (performance.now() - openedAt >= cancelGuardMs) (latest.current.onCancel ?? dismiss)();
    };
    // Escape is answered on the key itself. Left to the browser's close request
    // it is one the page may decline only once between two other presses, and a
    // second Escape in a row would close a dialog that had a page to step back
    // from. Other close requests (a phone's system back) still arrive as `cancel`.
    // The key takes back the last step first (`escape-steps.ts`): a question
    // asked in place, then whatever `onCancel` steps back from, then the dialog.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      cancel(event);
    };
    const backdrop = (event: MouseEvent) => {
      if (backdropDismiss && event.target === element && performance.now() - openedAt >= 400) dismiss();
    };
    const closed = () => latest.current.onClose();
    const tab = (event: KeyboardEvent) => {
      if (element.open && [...document.querySelectorAll("dialog[open]")].at(-1) === element) trapTab(element, event);
    };
    element.addEventListener("cancel", cancel);
    element.addEventListener("keydown", escape);
    element.addEventListener("click", backdrop);
    element.addEventListener("close", closed);
    document.addEventListener("keydown", tab);
    window.addEventListener("keydown", track, true);
    window.addEventListener("keyup", track, true);
    element.showModal();
    const disposeDrag = form?.current ? bindSheetDrag({
      dialog: element, form: form.current, scroller: scroller?.current ?? null, close: dismiss,
      detents: expandable ? {
        expanded: () => latest.current.detents?.expanded() ?? false,
        set: (next) => latest.current.detents?.set(next),
      } : undefined,
    }) : undefined;
    latest.current.focus?.();
    return () => {
      disposeDrag?.();
      element.removeEventListener("cancel", cancel);
      element.removeEventListener("keydown", escape);
      element.removeEventListener("click", backdrop);
      element.removeEventListener("close", closed);
      document.removeEventListener("keydown", tab);
      window.removeEventListener("keydown", track, true);
      window.removeEventListener("keyup", track, true);
      if (element.open) element.close();
      if (origin) queueMicrotask(() => {
        origin.live()?.focus({ preventScroll: true });
        origin.release();
      });
    };
  }, [dialog, form, scroller, restoreFocus, cancelGuardMs, expandable, backdropDismiss]);
  return deskForm;
}
