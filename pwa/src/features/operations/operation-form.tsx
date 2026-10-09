import { SheetHandle } from "../../shared/ui/overlay/sheet-content";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { OPERATION_INPUT_LIMITS } from "../../lib/operations";
import type { FormResult } from "./operation-form-model";
import { useDeskCancel } from "../../shared/ui/overlay/desk-form";
import { focusRefused } from "../../shared/ui/overlay/form-focus";
import { DeskCancel, ModalFrame, presentModal, type ModalController } from "../../shared/ui/overlay/modal";
import { bindSheetDrag } from "../../shared/ui/overlay/sheet-drag";

type Validation = { message: string; field?: string; id: string } | null;
const ValidationContext = createContext<Validation>(null);

function useFieldValidation(name: string) {
  const validation = useContext(ValidationContext);
  return validation?.field === name ? { "aria-invalid": true as const, "aria-describedby": validation.id } : {};
}

export function OperationField({ label, name, value = "", placeholder = "", required = false }: {
  label: string; name: string; value?: string; placeholder?: string; required?: boolean;
}) {
  const invalid = useFieldValidation(name);
  const maxLength = name === "label" ? OPERATION_INPUT_LIMITS.label
    : name === "branch" ? OPERATION_INPUT_LIMITS.branch : name === "base" ? OPERATION_INPUT_LIMITS.base
      : name === "path" ? OPERATION_INPUT_LIMITS.path : OPERATION_INPUT_LIMITS.cwd;
  return <label className="operation-field">{label}<input type="text" name={name} defaultValue={value}
    placeholder={placeholder} required={required} maxLength={maxLength} autoComplete="off" spellCheck={false} {...invalid} /></label>;
}

export function OperationSelect({ label, name, choices, selected }: {
  label: string; name: string; choices: Array<{ value: string; label: string }>; selected?: string;
}) {
  const invalid = useFieldValidation(name);
  const value = choices.some(choice => choice.value === selected) ? selected : choices[0]?.value;
  return <label className="operation-field">{label}<select name={name} defaultValue={value} {...invalid}>
    {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
  </select></label>;
}

export function OperationPrompt() {
  const invalid = useFieldValidation("text");
  return <label className="operation-field">{t("form.task")}<textarea name="text" required
    maxLength={OPERATION_INPUT_LIMITS.prompt} rows={7} {...invalid} /></label>;
}

export function OperationFrame<T>({ modal, title, children, onSubmit, onInput, focusDialog = false, step = "" }: {
  modal: ModalController<T>; title: string; children: ReactNode; focusDialog?: boolean;
  /** `stepClass()` read as the dialog was asked for, when it may open over another. */
  step?: string;
  onSubmit?: React.FormEventHandler<HTMLFormElement>; onInput?: React.FormEventHandler<HTMLFormElement>;
}) {
  useLayoutEffect(() => {
    // On a phone the card — and its scroll — lives on the form, not the dialog;
    // the drag must read the element that really scrolls or it eats the scroll.
    return bindSheetDrag({ dialog: modal.dialog.current!, form: modal.form.current!, scroller: modal.form.current,
      close: modal.dismiss });
  }, [modal]);
  return <ModalFrame modal={modal} title={title} className={`modal operation-modal ${step}`.trim()} onSubmit={onSubmit} onInput={onInput} deskClose
    focus={form => focusDialog ? modal.dialog.current?.focus() : form.querySelector<HTMLElement>("input, select, textarea, button")?.focus()}
    heading={<><SheetHandle />
      <h2 id={modal.titleId} className="modal-title">{title}</h2></>}>
    {children}
  </ModalFrame>;
}

/**
 * The form's two actions. The sheet stacks them, the submitting one on top
 * where the thumb is; the desk form's footer reads Cancel then the action, and
 * is written in that order so Tab meets them as they are seen.
 */
function FormActions({ submitLabel, onCancel }: { submitLabel: string; onCancel: () => void }) {
  if (useDeskCancel()) return <div className="desk-actions">
    <DeskCancel />
    <button type="submit" className="desk-action is-primary">{submitLabel}</button>
  </div>;
  return <div className="action-row">
    <button type="submit" className="btn btn-small btn-primary">{submitLabel}</button>
    <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>{t("cancel")}</button>
  </div>;
}

function FormDialog<T>({ modal, title, submitLabel, fields, read }: {
  modal: ModalController<T>; title: string; submitLabel: string; fields: ReactNode; read: (data: FormData) => FormResult<T>;
}) {
  const [validation, setValidation] = useState<Validation>(null);
  const validationId = `${modal.titleId}-validation`;
  // A refused submit leaves the reader in the field it is about (`form-focus`).
  useLayoutEffect(() => {
    if (validation?.field) focusRefused(modal.form.current, validation.field);
  }, [modal, validation]);
  return <ValidationContext value={validation}>
    <OperationFrame modal={modal} title={title} onInput={() => setValidation(null)} onSubmit={event => {
      event.preventDefault();
      const result = read(new FormData(event.currentTarget));
      if (result.ok) modal.close(result.value);
      else setValidation({ message: result.message, field: result.field, id: validationId });
    }}>
      <div className="operation-body">
        {fields}
        <p id={validationId} className="notice notice-error" role="alert" hidden={!validation}>{validation?.message}</p>
        <FormActions submitLabel={submitLabel} onCancel={modal.dismiss} />
      </div>
    </OperationFrame>
  </ValidationContext>;
}

export function formDialog<T>(title: string, submitLabel: string, fields: ReactNode,
  read: (data: FormData) => FormResult<T>): Promise<T | null> {
  return presentModal<T>(modal => <FormDialog modal={modal} title={title} submitLabel={submitLabel} fields={fields} read={read} />).result;
}
