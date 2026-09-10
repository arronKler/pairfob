import { useLayoutEffect, useRef, type ReactNode } from "react";
import { t } from "../../../lib/i18n";
import { bindSheetDrag } from "./sheet-drag";
import { presentModal, type ModalController } from "./modal";

export type SheetAction = () => void | Promise<void>;
export type ActionSheetController = ModalController<SheetAction>;

function SheetFrame({ modal, title, children }: {
  modal: ActionSheetController; title: string; children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dialog = modal.dialog.current!;
    const form = modal.form.current!;
    const openedAt = performance.now();
    const cancel = (event: Event) => { event.preventDefault(); modal.dismiss(); };
    const backdrop = (event: MouseEvent) => {
      if (event.target === dialog && performance.now() - openedAt >= 400) modal.dismiss();
    };
    const stopDrag = bindSheetDrag({ dialog, form, scroller: body.current, close: modal.dismiss });
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("click", backdrop);
    dialog.addEventListener("close", modal.finish);
    dialog.showModal();
    form.querySelector<HTMLButtonElement>("button:not(:disabled):not(.sheet-close)")?.focus();
    return () => {
      stopDrag();
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("click", backdrop);
      dialog.removeEventListener("close", modal.finish);
      if (dialog.open) dialog.close();
    };
  }, [modal]);
  return <dialog ref={modal.dialog} className="modal sheet" aria-labelledby={modal.titleId} data-react-modal="" data-react-action-sheet="">
    <form ref={modal.form} method="dialog" onSubmit={event => event.preventDefault()}>
      <div className="sheet-grab" aria-hidden="true"><span className="sheet-grab-bar" /></div>
      <div className="sheet-head"><h2 id={modal.titleId} className="modal-title">{title}</h2>
        <button type="button" className="icon-btn sheet-close" aria-label={t("close")} onClick={modal.dismiss}>×</button>
      </div>
      <div ref={body} className="sheet-body">{children}</div>
    </form>
  </dialog>;
}

/** Follow-up dialogs open on the next task, after native close and React teardown. */
export function showActionSheet(title: string, content: (modal: ActionSheetController) => ReactNode): void {
  for (const stale of document.querySelectorAll<HTMLDialogElement>("dialog.sheet[open]:not([data-react-action-sheet])")) stale.close();
  const modal = presentModal<SheetAction>(controller => <SheetFrame modal={controller} title={title}>
    {content(controller)}
  </SheetFrame>, { replaceKey: "action-sheet" });
  void modal.result.then(action => { if (action) window.setTimeout(() => void action(), 0); });
}

export function MenuItem({ modal, children, action, danger = false, disabled = false }: {
  modal: ActionSheetController; children: ReactNode; action?: SheetAction; danger?: boolean; disabled?: boolean;
}) {
  return <button type="button" className={`menu-item${danger ? " menu-danger" : ""}`} disabled={disabled}
    onClick={() => action ? modal.close(action) : modal.dismiss()}>{children}</button>;
}

export function MenuSection({ title, children }: { title: string; children: ReactNode }) {
  return <><h3 className="menu-section-title">{title}</h3>{children}</>;
}

export function MenuRadio({ modal, label, aria, selected, action, disabled = false }: {
  modal: ActionSheetController; label: string; aria: string; selected: boolean; action: SheetAction; disabled?: boolean;
}) {
  return <button type="button" className={`seg-item${selected ? " on" : ""}`} role="radio"
    aria-checked={selected} aria-label={aria} disabled={disabled} onClick={() => { if (!selected) modal.close(action); }}>{label}</button>;
}
