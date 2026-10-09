import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { t } from "../../lib/i18n";
import { SheetFrame } from "../../shared/ui/overlay/action-sheet";
import { CARD } from "../../shared/ui/overlay/desk-form";
import { presentModal, stepClass } from "../../shared/ui/overlay/modal";
import type { SheetOutcome } from "./operation-form-model";
import { WorktreeCreateForm, WorktreeOpenForm, type WorktreeFields } from "./worktree-forms";

/** Why an operation cannot run right now, as something a form can follow; empty when it can. */
export type OperationGate = { subscribe(listener: () => void): () => void; read(): string };

export type WorktreeFormRequest = { gate: OperationGate } & (
  | { kind: "create"; dir: string; start: (fields: WorktreeFields) => Promise<SheetOutcome> | null }
  | { kind: "open"; open: (target: { path: string } | { branch: string }) => Promise<SheetOutcome> });

/** iOS reports the keyboard inset over several frames; look again once it has settled. */
const KEYBOARD_SETTLE_MS = 320;

/**
 * In the bottom sheet the soft keyboard takes the lower half of the form
 * (`.worktree-form-sheet`, operations.scss): a focused field is brought into
 * view above the pinned footer once the keyboard has finished sliding in, as
 * the session panel does for the same form. A card has no keyboard under it.
 */
function useKeyboardReveal(sheet: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = sheet.current;
    if (!node) return;
    const reveal = (event: FocusEvent) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement) || node.closest("dialog")?.matches(CARD)) return;
      const show = () => { if (document.activeElement === field) field.scrollIntoView?.({ block: "nearest" }); };
      window.setTimeout(show, KEYBOARD_SETTLE_MS);
      window.visualViewport?.addEventListener("resize", show, { once: true });
    };
    node.addEventListener("focusin", reveal);
    return () => node.removeEventListener("focusin", reveal);
  }, [sheet]);
}

function Form({ request, modal, sheet }: {
  request: WorktreeFormRequest; modal: { dismiss(): void }; sheet: RefObject<HTMLElement | null>;
}) {
  useKeyboardReveal(sheet);
  const reason = useSyncExternalStore(request.gate.subscribe, request.gate.read);
  return request.kind === "create"
    ? <WorktreeCreateForm modal={modal} reason={reason} dir={request.dir} start={request.start} />
    : <WorktreeOpenForm modal={modal} reason={reason} open={request.open} />;
}

/**
 * A Worktree form in a dialog of its own: the form the session panel pushes as
 * a page (`worktree-forms`), under the same title, opened from somewhere that
 * has no panel to push it into. A mouse or the keyboard beside the list gets
 * the desk form; a finger, and every phone, the bottom sheet with the action
 * pinned above the keyboard. It runs its operation in place like the page
 * does. Resolves true once the operation is done and the dialog has closed on
 * it, false when the reader put the dialog away.
 */
export function showWorktreeForm(request: WorktreeFormRequest): Promise<boolean> {
  // Asked from a row of a dialog that stays open, it is that dialog's next step.
  const step = stepClass();
  return presentModal<boolean>(modal => <SheetFrame modal={modal} className={`worktree-form-sheet ${step}`.trim()}
    title={request.kind === "create" ? t("pm.wtNew") : t("menu.openWorktree")}>
    <Form request={request} modal={{ dismiss: () => modal.close(true) }} sheet={modal.form} />
  </SheetFrame>, { cancelValue: false }).result;
}
