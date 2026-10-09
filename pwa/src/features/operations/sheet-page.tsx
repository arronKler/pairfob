import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { SheetOutcome } from "./operation-form-model";
import { useDeskEnter } from "../../shared/ui/overlay/desk-form";
import { focusRefused, holdFocus } from "../../shared/ui/overlay/form-focus";
import { DeskCancel } from "../../shared/ui/overlay/modal";
import { deskInput } from "../../shared/ui/overlay/popover";
import { SheetFooter } from "../../shared/ui/overlay/sheet-content";
import { Button, Spinner } from "../../shared/ui/primitives";

/**
 * A form that runs its operation inside the sheet it was opened in: a page
 * pushed into the session panel, or the same form in a dialog of its own.
 *
 * One skeleton: the sheet's header names the page and the way back, the body
 * holds the form, and a footer says what will happen above the one primary
 * button. Running locks the form and spins the button; success closes the
 * sheet; failure stays on the page with the reason above the button.
 *
 * In a dialog a mouse or the keyboard opened the footer is the desk form's: a
 * quiet Cancel that steps back, then the action, at the bottom right
 * (`DeskCancel`, `desk-dialog.scss`), and Enter submits from a field or a
 * choice.
 *
 * The keyboard never falls off the form (`overlay/form-focus.ts`). A refused
 * submit puts a mouse or keyboard reader in the field it is about. While the
 * action runs the locked fields cannot hold focus, so the button that is
 * spinning does, and a failure gives it back to where the reader was.
 */
export type SheetRun = {
  pending: boolean;
  error: string;
  /** The field the last refusal named (`name` or `data-field`); its control is marked invalid. */
  field: string;
  clearError: () => void;
  /** Refuse before anything ran: say why and put the reader in `field`. */
  refuse: (message: string, field?: string) => void;
  submit: (work: () => Promise<SheetOutcome>) => Promise<void>;
  /** The form's root: where a refusal looks for its field and what a run locks. */
  form: RefObject<HTMLDivElement | null>;
  /** The primary button, which holds focus while the form is locked. */
  primary: RefObject<HTMLButtonElement | null>;
};

/** One submission at a time; the sheet closes on success. */
export function useSheetRun(modal: { dismiss(): void }): SheetRun {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState({ message: "", field: "", count: 0 });
  const busy = useRef(false);
  const form = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const [focus] = useState(holdFocus);
  const ran = useRef(false);
  useLayoutEffect(() => {
    if (pending) focus.lock(primary.current);
    else if (ran.current) focus.settle(primary.current);
    ran.current = pending;
  }, [focus, pending]);
  // After the unlock above, so a named field wins over where the reader was.
  // For a mouse or the keyboard only: a finger that tapped the button left no
  // keyboard position, and focusing a field there would raise the keyboard.
  useLayoutEffect(() => {
    if (refusal.count && refusal.field && deskInput()) focusRefused(form.current, refusal.field);
  }, [refusal]);
  const refuse = (message: string, field = "") => setRefusal(last => ({ message, field, count: last.count + 1 }));
  return {
    pending, error: refusal.message, field: refusal.field, form, primary, refuse,
    clearError: () => setRefusal(last => last.message || last.field ? { message: "", field: "", count: 0 } : last),
    async submit(work) {
      if (busy.current) return;
      busy.current = true;
      focus.note(form.current);
      setPending(true);
      setRefusal({ message: "", field: "", count: 0 });
      try {
        const outcome = await work();
        if (outcome.ok) modal.dismiss();
        else refuse(outcome.message);
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
  };
}

/** What a field named in the last refusal carries: it is the one the message under the form is about. */
export function refusedField(run: Pick<SheetRun, "field">, name: string, noteId: string): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return run.field === name ? { "aria-invalid": true, "aria-describedby": noteId } : {};
}

export function PageFooter({ summary, label, busyLabel, run, onSubmit, disabled = false, reason = "", noteId, background = false }: {
  summary?: ReactNode; label: string; busyLabel: string; run: Pick<SheetRun, "pending" | "error"> & Partial<Pick<SheetRun, "primary">>;
  onSubmit: () => void; disabled?: boolean; reason?: string;
  /** Names the note for the field a refusal is about (`refusedField`). */
  noteId?: string;
  /**
   * The action goes on without this page (a background job with a card of its
   * own): Cancel stays a way out while it runs, and the button only says so.
   */
  background?: boolean;
}) {
  // While this page's own operation runs it holds the lock; the busy reason is ours, not news.
  const note = run.error || (run.pending ? "" : reason);
  // Busy, the button is not `disabled`: it is what holds focus while the form
  // is locked, and it says so itself. A press on it does nothing meanwhile.
  return <SheetFooter>
    <div className="create-footer pane-page-footer">
      {summary ? <p className="create-summary">{summary}</p> : null}
      {note ? <p id={noteId} className={`pane-page-note${run.error ? " is-error" : ""}`} role={run.error ? "alert" : "status"}>{note}</p> : null}
      <DeskCancel disabled={run.pending && !background} />
      <Button ref={run.primary} className="btn btn-primary create-submit" disabled={!run.pending && (disabled || !!reason)}
        aria-disabled={run.pending || undefined} aria-busy={run.pending} onClick={run.pending ? undefined : onSubmit}>
        {run.pending ? <>{background ? null : <Spinner />}{busyLabel}</> : label}
      </Button>
      <p className="sr-only" role="status">{run.pending ? busyLabel : ""}</p>
    </div>
  </SheetFooter>;
}

/**
 * Enter in a single-line field submits the page; the sheet form itself never
 * submits. In the desk form a choice submits too (`useDeskEnter`).
 */
export function usePageEnter(submit: () => void) {
  const desk = useDeskEnter(submit);
  return (event: KeyboardEvent<HTMLElement>) => {
    desk(event);
    if (event.defaultPrevented || event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
}
