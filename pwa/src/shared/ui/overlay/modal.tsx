import { X } from "lucide-react";
import { t } from "../../../lib/i18n";
import { Button } from "../primitives/button";
import { DeskFormContext, dialogClass, useDeskCancel } from "./desk-form";
import { useDialogLifecycle } from "./dialog-lifecycle";
import { createEscapeSteps, EscapeStepsContext } from "./escape-steps";
import { deskPresentation } from "./popover";
import { followRemoval } from "./removal-focus";
import { followTrigger, liveTrigger, returnFocus } from "./trigger";
import { createRef, useLayoutEffect, useMemo, useRef, useState, type FormEventHandler, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

export type ModalController<T> = {
  titleId: string;
  dialog: RefObject<HTMLDialogElement | null>;
  form: RefObject<HTMLFormElement | null>;
  result: Promise<T | null>;
  close(value: T): void;
  dismiss(): void;
  finish(): void;
};

let serial = 0;
const replacements = new Map<string, () => void>();
type ModalOptions<T> = {
  replaceKey?: string;
  /** Where focus returns on close; defaults to what held it when the modal opened. */
  returnFocus?: HTMLElement;
  /** Where focus goes when that control cannot take it back (`returnFocus` in `trigger.ts`). */
  focusHome?: () => HTMLElement | null;
  cancelValue?: T;
  readClose?: (dialog: HTMLDialogElement) => T | null;
  /**
   * An accepted result removes what the dialog was opened from (a confirmed
   * close takes the row out of its list). Under a mouse or the keyboard on a
   * desk layout focus then follows to the row's successor (`removal-focus.ts`).
   * Without it only the control itself is followed, should what the dialog did
   * draw it again.
   */
  removes?: boolean;
};

/** One React-owned portal per modal; controller callers can keep promise APIs. */
export function presentModal<T>(view: (modal: ModalController<T>) => ReactNode,
  options: ModalOptions<T> & { cancelValue: T }): ModalController<T> & { result: Promise<T> };
export function presentModal<T>(view: (modal: ModalController<T>) => ReactNode, options?: ModalOptions<T>): ModalController<T>;
export function presentModal<T>(view: (modal: ModalController<T>) => ReactNode, options: ModalOptions<T> = {}): ModalController<T> {
  const { replaceKey } = options;
  if (replaceKey) replacements.get(replaceKey)?.();
  const trigger = options.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const origin = followTrigger(trigger);
  const root = createRoot(document.createDocumentFragment());
  let resolve!: (value: T | null) => void;
  let value: T | null = options.cancelValue ?? null;
  let accepted = false;
  let finished = false;
  let restoreFocus = true;
  const modal: ModalController<T> = {
    titleId: `modal-title-${++serial}`,
    dialog: createRef(),
    form: createRef(),
    result: new Promise<T | null>(done => { resolve = done; }),
    close(next) {
      if (finished) return;
      value = next;
      accepted = true;
      if (modal.dialog.current?.open) modal.dialog.current.close("accept");
      else modal.finish();
    },
    dismiss() {
      if (finished) return;
      value = options.cancelValue ?? null;
      accepted = false;
      if (modal.dialog.current?.open) modal.dialog.current.close("cancel");
      else modal.finish();
    },
    finish() {
      if (finished) return;
      finished = true;
      if (!accepted && modal.dialog.current && options.readClose) value = options.readClose(modal.dialog.current);
      flushSync(() => root.unmount());
      queueMicrotask(() => {
        const current = !replaceKey || replacements.get(replaceKey) === replace;
        if (replaceKey && current) replacements.delete(replaceKey);
        if (restoreFocus && current) {
          returnFocus(origin.live(), options.focusHome);
          // What the dialog did may have drawn its trigger again before it closed
          // (a split opens the new session under the same header): the one control
          // on the page that is what the trigger was takes focus back.
          if (deskPresentation() && (!document.activeElement || document.activeElement === document.body)) {
            liveTrigger(trigger)?.focus({ preventScroll: true });
          }
          const back = document.activeElement;
          if (deskPresentation() && back instanceof HTMLElement && back !== document.body) {
            followRemoval(back, { home: options.focusHome, redrawOnly: !(accepted && options.removes) });
          }
        }
        origin.release();
      });
      resolve(value);
    },
  };
  const replace = () => { restoreFocus = false; modal.dismiss(); };
  if (replaceKey) replacements.set(replaceKey, replace);
  flushSync(() => root.render(createPortal(view(modal), document.body)));
  return modal;
}

/**
 * What a dialog carries when it opened over another as the next step of it (a
 * row of the first asked for a form). While it is up the one beneath is not
 * drawn (`styles/overlay.scss`), so the reader sees one card, and putting the
 * step away (Escape, Cancel, the close control) shows the first again with
 * focus on the row that asked: the last step is undone, not the whole errand.
 */
export const DIALOG_STEP = "dialog-step";

/** The class for a dialog that is opening now: a step when another dialog is already open. */
export function stepClass(): string {
  return document.querySelector("dialog.modal[open]") ? DIALOG_STEP : "";
}

/**
 * The close control in the corner of a desk form: every dialog a mouse or the
 * keyboard opens beside the list carries its title at the top left and this at
 * the top right. It comes last in the form, after the fields and the footer a
 * Tab walks first: one order for every desk dialog, the document's and the
 * eye's alike.
 */
export function DeskClose({ onDismiss, label }: {
  onDismiss: () => void;
  /** What closing means here, when it is more than "close" (an editor that sets its draft aside): the name and the tooltip. */
  label?: string;
}) {
  return <Button className="icon-btn desk-close" aria-label={label ?? t("close")} title={label} onClick={onDismiss}>
    <X size={18} aria-hidden="true" /></Button>;
}

/**
 * The quiet Cancel of a desk form's footer, written right before the action it
 * stands beside. It draws nothing in a bottom sheet, which is put away by its
 * bar, its handle or the backdrop. Inside a page pushed into a dialog it steps
 * back to the page before; a caller with a draft to set aside passes its own.
 */
export function DeskCancel({ onCancel, disabled = false }: { onCancel?: () => void; disabled?: boolean }) {
  const cancel = useDeskCancel();
  if (!cancel) return null;
  return <Button className="desk-cancel" disabled={disabled} onClick={onCancel ?? cancel}>{t("cancel")}</Button>;
}

export function ModalFrame<T>({ modal, title, className = "modal", heading, children, onSubmit, onInput, describedBy, focus, deskClose = false }: {
  modal: ModalController<T>;
  title: string;
  className?: string;
  heading?: ReactNode;
  children: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  onInput?: FormEventHandler<HTMLFormElement>;
  describedBy?: string;
  focus?: (form: HTMLFormElement) => void;
  /** Draw the desk form's corner close (`DeskClose`); a dialog whose own head closes it leaves this off. */
  deskClose?: boolean;
}) {
  const [steps] = useState(createEscapeSteps);
  const deskForm = useDialogLifecycle({ dialog: modal.dialog, onDismiss: modal.dismiss, onClose: modal.finish, steps,
    focus: () => { if (modal.form.current) focus?.(modal.form.current); } });
  const desk = useMemo(() => deskForm ? { cancel: modal.dismiss } : null, [deskForm, modal]);
  // A dialog may draw its actions in another place per presentation (a bar
  // above the field in the sheet, a footer under it in the card). When the
  // window crosses the tier under an open dialog the control that held focus is
  // drawn anew, and the dialog starts again where it first put the reader.
  const drawn = useRef(deskForm);
  useLayoutEffect(() => {
    if (drawn.current === deskForm) return;
    drawn.current = deskForm;
    const form = modal.form.current;
    if (form && !form.contains(document.activeElement)) focus?.(form);
  });
  return <dialog ref={modal.dialog} className={dialogClass(className, deskForm)} aria-labelledby={modal.titleId}
    aria-describedby={describedBy} data-react-modal="">
    <form ref={modal.form} method="dialog" onSubmit={onSubmit ?? (event => event.preventDefault())} onInput={onInput}>
      <EscapeStepsContext value={steps}>
        <DeskFormContext value={desk}>
          {heading ?? <h2 id={modal.titleId} className="modal-title">{title}</h2>}
          {children}
          {deskClose && deskForm ? <DeskClose onDismiss={modal.dismiss} /> : null}
        </DeskFormContext>
      </EscapeStepsContext>
    </form>
  </dialog>;
}
