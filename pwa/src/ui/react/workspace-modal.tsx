import { useLayoutEffect, useRef, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../lib/i18n";
import { bindSheetDrag } from "../../lib/sheet-drag";
import { Button } from "./chrome";

const OPEN_GESTURE_MS = 400;

type WorkspaceDialogProps = {
  className: string;
  titleId: string;
  title?: string;
  sheet?: boolean;
  onDismiss: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  initialFocus?: () => HTMLElement | null;
};

/** Native `<dialog>` for workspace note editor and branch sheet. */
export function WorkspaceDialog({
  className, titleId, title, sheet = false, onDismiss, onSubmit, children, initialFocus,
}: WorkspaceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  const trigger = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const initialFocusRef = useRef(initialFocus);
  onDismissRef.current = onDismiss;
  initialFocusRef.current = initialFocus;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const form = formRef.current;
    if (!dialog) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openedAt.current = performance.now();
    const closed = () => onDismissRef.current();
    dialog.addEventListener("close", closed);
    dialog.showModal();
    const focus = initialFocusRef.current?.() ?? form?.querySelector<HTMLButtonElement>("button:not(:disabled):not(.sheet-close)");
    focus?.focus();
    const disposeDrag = sheet && form
      ? bindSheetDrag({ dialog, form, scroller: bodyRef.current, close: () => onDismissRef.current() })
      : undefined;
    return () => {
      dialog.removeEventListener("close", closed);
      disposeDrag?.();
      if (dialog.open) dialog.close();
      document.body.classList.remove("sheet-open", "sheet-dragging");
      document.body.style.removeProperty("--sheet-lift");
      const restore = trigger.current;
      queueMicrotask(() => {
        if (restore?.isConnected) restore.focus({ preventScroll: true });
      });
    };
  }, [sheet]);

  const guardedDismiss = () => {
    if (performance.now() - openedAt.current < OPEN_GESTURE_MS) return;
    onDismiss();
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className={className}
      data-react-modal=""
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        guardedDismiss();
      }}
      onClick={(event) => {
        if (event.target !== dialogRef.current) return;
        guardedDismiss();
      }}
    >
      <form
        ref={formRef}
        method="dialog"
        onSubmit={(event) => {
          if (onSubmit) onSubmit(event);
          else event.preventDefault();
        }}
      >
        {sheet && <div className="sheet-grab" aria-hidden="true"><span className="sheet-grab-bar" /></div>}
        {sheet ? (
          <>
            <div className="sheet-head">
              <h2 className="modal-title" id={titleId}>{title}</h2>
              <Button className="icon-btn sheet-close" aria-label={t("close")} onClick={onDismiss}>×</Button>
            </div>
            <div ref={bodyRef} className="sheet-body">{children}</div>
          </>
        ) : children}
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
