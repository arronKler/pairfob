import { Plus } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { DeskCancel, DeskClose, presentModal, type ModalController } from "../../../shared/ui/overlay/modal";
import { DeskFormContext, dialogClass } from "../../../shared/ui/overlay/desk-form";
import { useDialogLifecycle } from "../../../shared/ui/overlay/dialog-lifecycle";
import { overlayOrigin } from "../../../shared/ui/overlay/origin";
import { QUICK_LABEL_LIMIT, QUICK_TEXT_LIMIT, type QuickCommand } from "../../settings/quick-command-model";

export function defaultQuickCommands(): QuickCommand[] {
  return [
    { id: "review", label: t("quick.reviewLabel"), text: t("quick.reviewText"), pinned: false },
    { id: "test", label: t("quick.testLabel"), text: t("quick.testText"), pinned: false },
    { id: "summary", label: t("quick.summaryLabel"), text: t("quick.summaryText"), pinned: false },
  ];
}

export type QuickCommandEdit = { action: "save"; label: string; text: string } | { action: "delete" };

/** What one reorder step did: moved within a group, across the slash commands, refused, or nowhere to go. */
export type QuickCommandStep = "moved" | "pinned" | "unpinned" | "pins-full" | null;

/** Keyboard and screen-reader reordering; dragging on the pad is pointer-only. Applied and saved at once. */
export type QuickCommandReorder = {
  can(direction: -1 | 1): boolean;
  step(direction: -1 | 1): QuickCommandStep;
};

type EditorRequest = {
  reorder?: QuickCommandReorder;
  /** Absent for a new command. */
  command?: QuickCommand;
  /** The current compose draft, offered as the new command's content. */
  draft?: string;
};

/** A draft's first line, short enough to read on a pad button. */
export function draftLabel(draft: string): string {
  return (draft.trim().split("\n")[0] ?? "").trim().slice(0, 8);
}

const STEP_COPY = {
  moved: "pad.moved", pinned: "pad.movedFirst", unpinned: "pad.movedAfter", "pins-full": "pad.pinsFull",
} as const;

function ReorderRow({ reorder }: { reorder: QuickCommandReorder }) {
  const [result, setResult] = useState<QuickCommandStep>(null);
  const button = (direction: -1 | 1) => <button type="button" className="quick-sheet-step"
    aria-label={t(direction < 0 ? "pad.moveEarlierAria" : "pad.moveLaterAria")}
    disabled={!reorder.can(direction)} onClick={() => setResult(reorder.step(direction))}>
    {t(direction < 0 ? "pad.moveEarlier" : "pad.moveLater")}</button>;
  return <div className="quick-sheet-reorder">
    <span className="quick-sheet-field-head">{t("pad.position")}</span>
    <div className="quick-sheet-steps">{button(-1)}{button(1)}</div>
    <p className="quick-sheet-hint" role="status">{result ? t(STEP_COPY[result]) : ""}</p>
  </div>;
}

function QuickCommandSheet({ modal, command, draft = "", reorder }: EditorRequest & { modal: ModalController<QuickCommandEdit> }) {
  const [label, setLabel] = useState(command?.label ?? "");
  const [text, setText] = useState(command?.text ?? "");
  const [fromDraft, setFromDraft] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const labelField = useRef<HTMLInputElement>(null);
  const creating = !command;
  const complete = Boolean(label.trim() && text.trim());
  // A new command starts in its name. So does one being edited where a mouse or
  // the keyboard opened it; under a finger that would raise the on-screen
  // keyboard over a command the reader may only want to move or delete.
  const start = (desk: boolean) => {
    if (!creating && !desk) return;
    labelField.current?.focus({ preventScroll: true });
    if (!creating) labelField.current?.select();
  };
  const deskRef = useRef(false);
  const deskForm = useDialogLifecycle({ dialog: modal.dialog, onDismiss: modal.dismiss, onClose: modal.finish, cancelGuardMs: 0,
    sheet: { form: modal.form, scroller: body },
    focus: () => start(deskRef.current) });
  deskRef.current = deskForm;
  const desk = useMemo(() => deskForm ? { cancel: modal.dismiss } : null, [deskForm, modal]);
  // The two actions are the sheet's bar or the card's footer, drawn anew when
  // the window crosses the tier; focus that was on one of them starts over.
  const drawn = useRef(deskForm);
  useLayoutEffect(() => {
    if (drawn.current === deskForm) return;
    drawn.current = deskForm;
    if (!modal.form.current?.contains(document.activeElement)) labelField.current?.focus({ preventScroll: true });
  });
  const title = t(creating ? "pad.sheetNew" : "pad.sheetEdit");
  const heading = <h2 id={modal.titleId} className="modal-title">{title}</h2>;
  const submit = (className: string) => <button type="submit" className={className} disabled={!complete}>
    {t(creating ? "pad.sheetAdd" : "pad.sheetDone")}</button>;
  return <dialog ref={modal.dialog} className={dialogClass("modal sheet quick-command-sheet", deskForm)} aria-labelledby={modal.titleId} data-react-modal="">
    <form ref={modal.form} method="dialog" onSubmit={event => {
      event.preventDefault();
      if (complete) modal.close({ action: "save", label: label.trim(), text });
    }}>
      <div className="sheet-grab" aria-hidden="true"><span className="sheet-grab-bar" /></div>
      {/* The sheet's bar is iOS-shaped; the desk form has its title here and its actions after the fields. */}
      {deskForm ? <div className="quick-sheet-title">{heading}</div> : <div className="quick-sheet-bar">
        <button type="button" className="quick-sheet-text-btn" onClick={modal.dismiss}>{t("pad.sheetCancel")}</button>
        {heading}
        {submit("quick-sheet-text-btn is-primary")}
      </div>}
      <div ref={body} className="quick-sheet-body">
        {creating && draft.trim() && !fromDraft && <button type="button" className="quick-sheet-draft" onClick={() => {
          setText(draft.slice(0, QUICK_TEXT_LIMIT));
          if (!label.trim()) setLabel(draftLabel(draft));
          setFromDraft(true);
        }}><span><b>{t("pad.fromDraft")}</b><small>{draft.trim().split("\n")[0]}</small></span><Plus size={18} aria-hidden="true" /></button>}
        <label className="quick-sheet-field">
          <span className="quick-sheet-field-head">{t("pad.fieldLabel")}
            <span className="quick-sheet-count">{t("pad.count", { count: label.length, limit: QUICK_LABEL_LIMIT })}</span></span>
          <input ref={labelField} value={label} maxLength={QUICK_LABEL_LIMIT} placeholder={t("pad.fieldLabelPlaceholder")}
            enterKeyHint="next" onChange={event => setLabel(event.target.value)} />
        </label>
        <label className="quick-sheet-field">
          <span className="quick-sheet-field-head">{t("pad.fieldText")}
            <span className="quick-sheet-count">{t("pad.count", { count: text.length, limit: QUICK_TEXT_LIMIT })}</span></span>
          {/* Enter is a new line in the command; ⌘ or Ctrl with it is the form's submit, as in the note editor. */}
          <textarea value={text} maxLength={QUICK_TEXT_LIMIT} rows={4} placeholder={t("pad.fieldTextPlaceholder")}
            onChange={event => setText(event.target.value)} onKeyDown={event => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
              event.preventDefault();
              modal.form.current?.requestSubmit();
            }} />
        </label>
        <p className="quick-sheet-hint">{t("pad.sheetHint")}</p>
        {!creating && reorder && <ReorderRow reorder={reorder} />}
        {!creating && <button type="button" className="quick-sheet-delete"
          onClick={() => modal.close({ action: "delete" })}>{t("pad.sheetDelete")}</button>}
      </div>
      {deskForm ? <DeskFormContext value={desk}>
        <div className="desk-actions quick-sheet-actions"><DeskCancel />{submit("desk-action is-primary")}</div>
        <DeskClose onDismiss={modal.dismiss} />
      </DeskFormContext> : null}
    </form>
  </dialog>;
}

/**
 * The half-height editor for one command. It only reports what the reader
 * chose; the pad owns where the command goes and saves the list.
 */
export function editQuickCommand(request: EditorRequest): Promise<QuickCommandEdit | null> {
  return presentModal<QuickCommandEdit>(modal => <QuickCommandSheet modal={modal} {...request} />,
    { replaceKey: "quick-command", returnFocus: opener() }).result;
}

/**
 * The pad's button that asked for the editor, under a mouse or the keyboard.
 * A pad button does not take focus when it is pressed (the compose field keeps
 * the caret), so what held focus is not what opened the editor; the gesture
 * is. A finger keeps the default: focus goes back to where it was, which is
 * what brings the on-screen keyboard back.
 */
function opener(): HTMLElement | undefined {
  const origin = overlayOrigin();
  if (origin?.input !== "mouse" && origin?.input !== "key") return undefined;
  const control = origin.target?.closest("button");
  return control instanceof HTMLElement ? control : undefined;
}
