import { useEffect, useLayoutEffect, useMemo, useRef, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DeskFormContext, dialogClass } from "../../shared/ui/overlay/desk-form";
import { useDialogLifecycle } from "../../shared/ui/overlay/dialog-lifecycle";
import { SheetContent } from "../../shared/ui/overlay/sheet-content";
import { Button } from "../../shared/ui/primitives";

type WorkspaceDialogProps = {
  className: string;
  titleId: string;
  title?: string;
  sheet?: boolean;
  onDismiss: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  initialFocus?: () => HTMLElement | null;
  /** Editors keep their draft: a backdrop tap does not dismiss them. */
  keepOnBackdrop?: boolean;
  /** The Escape key, where it does not mean what dismissing does (an editor sets its draft aside). */
  onEscape?: () => void;
};

/**
 * Native `<dialog>` for workspace note editor and branch sheet. Its children
 * learn from `DeskFormContext` whether it is drawn as the desk form, as in any
 * shared dialog: Cancel there is `onDismiss`.
 */
export function WorkspaceDialog({
  className, titleId, title, sheet = false, onDismiss, onSubmit, children, initialFocus, keepOnBackdrop = false, onEscape,
}: WorkspaceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // A close request does not say what asked for it, and a phone's system back
  // asks the same way. Only the key itself tells Escape apart. It is watched on
  // the window: the request comes whatever holds focus, and a key pressed while
  // nothing in the dialog does (Tab has just left its last control) never
  // passes through the dialog.
  const escapeDown = useRef(false);
  const tracksEscape = Boolean(onEscape);
  useEffect(() => {
    if (!tracksEscape) return;
    const track = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapeDown.current = event.type === "keydown";
    };
    window.addEventListener("keydown", track, true);
    window.addEventListener("keyup", track, true);
    return () => {
      window.removeEventListener("keydown", track, true);
      window.removeEventListener("keyup", track, true);
    };
  }, [tracksEscape]);
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusFirst = () => {
    const target = initialFocus?.() ?? formRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled):not(.sheet-close)");
    target?.focus();
  };
  const deskForm = useDialogLifecycle({ dialog: dialogRef, onDismiss, onClose: onDismiss, restoreFocus: true, backdropDismiss: !keepOnBackdrop,
    onCancel: onEscape ? () => (escapeDown.current ? onEscape : onDismiss)() : undefined,
    sheet: sheet ? { form: formRef, scroller: bodyRef } : undefined,
    focus: focusFirst });
  const desk = useMemo(() => deskForm ? { cancel: onDismiss } : null, [deskForm, onDismiss]);
  // The sheet's bar and the card's footer are different buttons. A window that
  // crosses the tier under the open dialog draws the one for the other, and a
  // button that held focus is gone: the dialog starts again where it first put
  // the reader, as the shared frame does.
  const drawn = useRef(deskForm);
  useLayoutEffect(() => {
    if (drawn.current === deskForm) return;
    drawn.current = deskForm;
    if (formRef.current && !formRef.current.contains(document.activeElement)) focusFirst();
  });

  return createPortal(
    <dialog
      ref={dialogRef}
      className={dialogClass(className, deskForm)}
      data-react-modal=""
      aria-labelledby={titleId}
    >
      <form
        ref={formRef}
        method="dialog"
        onSubmit={(event) => {
          if (onSubmit) onSubmit(event);
          else event.preventDefault();
        }}
      >
        <DeskFormContext value={desk}>
          {sheet ? <SheetContent title={title ?? ""} titleId={titleId} onDismiss={onDismiss} bodyRef={bodyRef}>
            {children}
          </SheetContent> : children}
        </DeskFormContext>
      </form>
    </dialog>,
    document.body,
  );
}

export function SheetItem({ label, onPick, variant = "", disabled = false }: {
  label: string; onPick: () => void | Promise<void>; variant?: "" | "danger"; disabled?: boolean;
}) {
  return <Button className={`menu-item${variant ? ` menu-${variant}` : ""}`} disabled={disabled} onClick={() => {
    window.setTimeout(() => void onPick(), 0);
  }}>{label}</Button>;
}
