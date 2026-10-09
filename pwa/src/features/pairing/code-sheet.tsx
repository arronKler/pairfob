import { useId, useRef, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { t } from "../../lib/i18n";
import { DeskFormContext, dialogClass } from "../../shared/ui/overlay/desk-form";
import { useDialogLifecycle } from "../../shared/ui/overlay/dialog-lifecycle";
import { DeskCancel } from "../../shared/ui/overlay/modal";
import { SheetContent } from "../../shared/ui/overlay/sheet-content";
import { Button } from "../../shared/ui/primitives";
import { PairCodeField } from "./code-field";
import type { ConnectViewModel } from "./model";

/**
 * The typed-code fallback as a bottom sheet (a centered modal on desk). Its
 * open state is the pairing domain's `pairManualOpen`, so a code error, a paste
 * or "enter the code instead" from the scanner all open the same sheet, and
 * dismissing it keeps the draft and its error for the next open. The sheet
 * lifts above the soft keyboard; opened with the keyboard beside the list it is
 * the desk form, with the footer every desk dialog has.
 */
export function PairCodeSheet({ view, onDismiss, onPaste, onSubmit, onCodeChange }: {
  view: ConnectViewModel;
  onDismiss: () => void;
  onPaste: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCodeChange: (code: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const deskForm = useDialogLifecycle({ dialog, onDismiss, onClose: onDismiss, restoreFocus: true, cancelGuardMs: 0,
    sheet: { form, scroller: body },
    focus: () => form.current?.querySelector<HTMLInputElement>("#pair-code")?.focus({ preventScroll: true }) });
  return createPortal(
    <dialog ref={dialog} className={dialogClass("modal sheet pair-code-sheet", deskForm)} aria-labelledby={titleId} data-react-modal="" data-state-portal="">
      <form ref={form} method="dialog" className="connect-form" noValidate onSubmit={onSubmit}>
        <SheetContent title={t("connect.manual")} titleId={titleId} onDismiss={onDismiss} bodyRef={body}>
          <PairCodeField view={view} placeholder={t("connect.pairHint")} onPaste={onPaste} onCodeChange={onCodeChange} />
          {deskForm ? (
            // The desk form ends as every desk dialog does: a quiet Cancel, then the action.
            <DeskFormContext value={{ cancel: onDismiss }}>
              <div className="desk-actions">
                <DeskCancel />
                <button type="submit" className="desk-action is-primary">{t("connect.submit")}</button>
              </div>
            </DeskFormContext>
          ) : <Button type="submit" className="btn btn-primary btn-connect">{t("connect.submit")}</Button>}
        </SheetContent>
      </form>
    </dialog>,
    document.body,
  );
}
