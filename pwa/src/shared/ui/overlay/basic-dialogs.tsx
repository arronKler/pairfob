import { TriangleAlert, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { Button } from "../primitives/button";
import { useDeskCancel } from "./desk-form";
import { DeskCancel, ModalFrame, presentModal, type ModalController } from "./modal";

/**
 * A single-field editor. In the sheet Cancel and Save sit in the heading, above
 * the field, so an on-screen keyboard never covers them. The desk form draws
 * them as its footer, and writes them there too: after the field in the
 * document, so Tab and a screen reader meet them where the eye does. Save
 * stays disabled until the value changes. Enter commits the same way: an
 * unchanged value dismisses with `null` and a blank required value stays open.
 * A disabled default button would otherwise swallow the browser's implicit
 * submission.
 */
export type TextRequest = {
  title: string;
  initial?: string;
  maxLength?: number;
  /** The field's name; defaults to a generic "Name". */
  label?: string;
  /** Guidance under the field, e.g. what an empty value means. */
  hint?: string;
  /** Replaces `hint` while the field is empty. */
  emptyHint?: string;
  /** When false, Save stays disabled for a blank value. */
  allowEmpty?: boolean;
  /** Live check; a message marks the field invalid, replaces the hint and blocks Save. */
  validate?: (value: string) => string | null;
};

/** The sheet's bar (Cancel · title · Save); in the desk form the title alone. */
function TextHead({ modal, title, canSave }: { modal: ModalController<string>; title: string; canSave: boolean }) {
  const heading = <h2 id={modal.titleId} className="modal-title">{title}</h2>;
  if (useDeskCancel()) return heading;
  return <div className="text-edit-head">
    <Button className="text-edit-action" onClick={modal.dismiss}>{t("cancel")}</Button>
    {heading}
    <button type="submit" className="text-edit-action text-edit-save" disabled={!canSave}>{t("text.save")}</button>
  </div>;
}

/** The desk form's footer; the sheet has its bar instead. */
function TextFooter({ canSave }: { canSave: boolean }) {
  if (!useDeskCancel()) return null;
  return <div className="desk-actions">
    <DeskCancel />
    <button type="submit" className="desk-action is-primary text-edit-save" disabled={!canSave}>{t("text.save")}</button>
  </div>;
}

function TextDialog({ modal, request }: { modal: ModalController<string>; request: TextRequest }) {
  const { title, initial = "", maxLength, label, hint, emptyHint, allowEmpty = true, validate } = request;
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const blank = !value.trim();
  const problem = value === initial ? null : validate?.(value) ?? null;
  const canSave = value !== initial && (allowEmpty || !blank) && !problem;
  const guidance = problem ?? (!value && emptyHint ? emptyHint : !allowEmpty && blank ? t("text.nameRequired") : hint);
  const commit = (next: string) => {
    if (next === initial) modal.dismiss();
    else if (validate?.(next)) return;
    else if (allowEmpty || next.trim()) modal.close(next);
  };
  return <ModalFrame modal={modal} title={title} className="modal text-edit" describedBy={guidance ? hintId : undefined} deskClose
    focus={form => { const field = form.querySelector("input")!; field.focus(); field.select(); }}
    heading={<TextHead modal={modal} title={title} canSave={canSave} />}
    onSubmit={event => {
      event.preventDefault();
      commit((event.currentTarget.elements.namedItem("value") as HTMLInputElement).value);
    }}>
    <label className="text-edit-label" htmlFor={fieldId}>{label ?? t("op.fieldName")}</label>
    <div className={`text-edit-field${problem ? " is-invalid" : ""}`}>
      <input ref={input} id={fieldId} name="value" type="text" autoComplete="off" spellCheck={false} enterKeyHint="done"
        defaultValue={initial} maxLength={maxLength} aria-invalid={problem ? true : undefined} onInput={event => setValue(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          commit(event.currentTarget.value);
        }} />
      {value && <Button className="text-edit-clear" aria-label={t("text.clear")} onClick={() => {
        if (!input.current) return;
        input.current.value = "";
        setValue("");
        input.current.focus();
      }}><X size={14} aria-hidden="true" /></Button>}
    </div>
    {guidance && <p id={hintId} className={`text-edit-hint${problem ? " is-invalid" : ""}`} role={problem ? "alert" : undefined}>{guidance}</p>}
    <TextFooter canSave={canSave} />
  </ModalFrame>;
}

export function askText(request: TextRequest): Promise<string | null> {
  return presentModal<string>(modal => <TextDialog modal={modal} request={request} />, {
    readClose: dialog => dialog.returnValue === "cancel" ? null : dialog.querySelector("input")!.value,
  }).result;
}

export type HelpBlock = string | { before: string; code: string; after: string };

/** The centred card's own head with its close; the desk form has the shared title and corner close. */
function HelpHead({ titleId, title, onDismiss }: { titleId: string; title: string; onDismiss: () => void }) {
  const heading = <h2 id={titleId} className="modal-title">{title}</h2>;
  if (useDeskCancel()) return heading;
  return <div className="help-head">{heading}
    <button type="button" className="icon-btn help-close" aria-label={t("close")} onClick={onDismiss}><X size={20} aria-hidden="true" /></button>
  </div>;
}

/** Nothing to confirm or cancel: the desk form's footer is the one button that puts it away. */
function HelpFooter({ onDismiss }: { onDismiss: () => void }) {
  if (!useDeskCancel()) return null;
  return <div className="desk-actions">
    <Button className="desk-action is-primary help-done" onClick={onDismiss}>{t("desk.gotIt")}</Button>
  </div>;
}

export function showHelp(title: string, blocks: HelpBlock[]): void {
  presentModal<never>(modal => {
    const ids = blocks.map((_, i) => `${modal.titleId}-copy-${i}`);
    return <ModalFrame modal={modal} title={title} className="modal help" describedBy={ids.join(" ") || undefined} deskClose
      focus={form => form.querySelector<HTMLButtonElement>(".help-done, .help-close")!.focus()}
      heading={<HelpHead titleId={modal.titleId} title={title} onDismiss={modal.dismiss} />}>
      {blocks.map((block, i) => <p key={i} id={ids[i]} className="help-copy">
        {typeof block === "string" ? block : <>{block.before}<code>{block.code}</code>{block.after}</>}
      </p>)}
      <HelpFooter onDismiss={modal.dismiss} />
    </ModalFrame>;
  }, { replaceKey: "help" });
}

/**
 * A confirmation that names its action and its object. The title is the
 * question itself; `subject` shows what is affected and its state; `warning`
 * calls out a consequence the reader might not expect (e.g. running work).
 *
 * It opens on Cancel, the safe answer, so Enter straight away changes nothing.
 * A confirmed destructive action usually removes the row it was asked from;
 * focus follows to that row's successor (`removal-focus.ts`).
 */
export type ConfirmRequest = {
  title: string;
  message?: string;
  subject?: { name: string; detail?: string; status?: string };
  warning?: string;
  confirmLabel: string;
  /** Destructive by default; a reversible confirmation uses the primary tone. */
  tone?: "danger" | "primary";
};

export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  const { title, message, subject, warning, confirmLabel, tone = "danger" } = request;
  return presentModal<boolean>(modal => {
    const copyId = `${modal.titleId}-copy`;
    return <ModalFrame modal={modal} title={title} className="modal confirm" describedBy={message || warning ? copyId : undefined} deskClose
      focus={form => form.querySelector<HTMLButtonElement>(".confirm-cancel")!.focus()}>
      {subject && <div className="confirm-subject">
        <strong className="confirm-name">{subject.name}</strong>
        {subject.detail && <code className="confirm-detail">{subject.detail}</code>}
        {subject.status && <span className={`confirm-status${warning ? " is-busy" : ""}`}>{subject.status}</span>}
      </div>}
      <div id={copyId}>
        {message && <p className="lede confirm-copy">{message}</p>}
        {warning && <p className="confirm-warning"><TriangleAlert size={16} aria-hidden="true" /><span>{warning}</span></p>}
      </div>
      <div className="action-row confirm-actions">
        <button type="button" className="btn btn-small btn-ghost confirm-cancel" autoFocus onClick={modal.dismiss}>{t("cancel")}</button>
        <button type="button" className={`btn btn-small ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
          onClick={() => modal.close(true)}>{confirmLabel}</button>
      </div>
    </ModalFrame>;
  }, { cancelValue: false, readClose: dialog => dialog.returnValue === "confirm", removes: tone === "danger" }).result;
}
