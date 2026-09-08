import { t } from "./i18n";
import { ModalFrame, presentModal } from "./react-modal";

export function askText(title: string, initial = "", maxLength?: number, fieldLabel?: string): Promise<string | null> {
  return presentModal<string>(modal => <ModalFrame modal={modal} title={title}
    focus={form => { const input = form.querySelector("input")!; input.focus(); input.select(); }}
    onSubmit={event => {
      event.preventDefault();
      modal.close((event.currentTarget.elements.namedItem("value") as HTMLInputElement).value);
    }}>
    <label>{fieldLabel ?? t("op.fieldName")}<input name="value" type="text" autoComplete="off" spellCheck={false}
      placeholder="" defaultValue={initial} maxLength={maxLength} /></label>
    <div className="action-row">
      <button type="submit" className="btn btn-small btn-primary">{t("confirm")}</button>
      <button type="button" className="btn btn-small btn-ghost" onClick={modal.dismiss}>{t("cancel")}</button>
    </div>
  </ModalFrame>, {
    readClose: dialog => dialog.returnValue === "cancel" ? null : dialog.querySelector("input")!.value,
  }).result;
}

export type HelpBlock = string | { before: string; code: string; after: string };

export function showHelp(title: string, blocks: HelpBlock[]): void {
  presentModal<never>(modal => {
    const ids = blocks.map((_, i) => `${modal.titleId}-copy-${i}`);
    return <ModalFrame modal={modal} title={title} className="modal help" describedBy={ids.join(" ") || undefined}
      focus={form => form.querySelector<HTMLButtonElement>(".help-close")!.focus()}
      heading={<div className="help-head"><h2 id={modal.titleId} className="modal-title">{title}</h2>
        <button type="button" className="icon-btn help-close" aria-label={t("close")} onClick={modal.dismiss}>×</button>
      </div>}>
      {blocks.map((block, i) => <p key={i} id={ids[i]} className="help-copy">
        {typeof block === "string" ? block : <>{block.before}<code>{block.code}</code>{block.after}</>}
      </p>)}
    </ModalFrame>;
  }, { replaceKey: "help" });
}

export function askConfirm(message: string, confirmLabel?: string): Promise<boolean> {
  return presentModal<boolean>(modal => <ModalFrame modal={modal} title={t("op.dangerTitle")}
    focus={form => form.querySelector<HTMLButtonElement>(".btn-ghost")!.focus()}>
    <p className="lede">{message}</p>
    <div className="action-row">
      <button type="button" className="btn btn-small btn-danger" onClick={() => modal.close(true)}>{confirmLabel ?? t("confirm")}</button>
      <button type="button" className="btn btn-small btn-ghost" autoFocus onClick={modal.dismiss}>{t("cancel")}</button>
    </div>
  </ModalFrame>, { cancelValue: false, readClose: dialog => dialog.returnValue === "confirm" }).result;
}
