import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { canPromptAgent } from "../../lib/dashboard";
import {
  DIFF_NOTE_BODY_LIMIT,
  diffNoteForPin,
  diffNoteSendOpen,
  diffNoteSending,
  diffNotesFor,
  removeDiffNote,
  upsertDiffNote,
  type DiffNoteTarget,
} from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import type { GitLayer } from "../../lib/workspace";
import { sendDiffNotesToAgent } from "../../live-operations";
import { render } from "../../paint";
import { selectedAgent, state } from "../../state";
import { Button } from "./chrome";
import { WorkspaceDialog } from "./workspace-modal";

let editorSerial = 0;

export function diffLineHasNote(target: DiffNoteTarget): boolean {
  return diffNoteForPin(target) !== undefined;
}

export function diffNoteLineLabel(target: Pick<DiffNoteTarget, "line" | "side">): string {
  const side = target.side === "old" ? t("diffNotes.sideOld") : t("diffNotes.sideNew");
  return t("diffNotes.promptLine", { line: target.line, side });
}

function editorTitle(target: DiffNoteTarget, editing: boolean): string {
  return t(editing ? "diffNotes.editTitle" : "diffNotes.addTitle", { line: target.line });
}

export function DiffNoteEditor({ target, onClose }: { target: DiffNoteTarget; onClose: (changed: boolean) => void }) {
  const existing = diffNoteForPin(target);
  const [titleId] = useState(() => `diff-note-title-${++editorSerial}`);
  const [validationId] = useState(() => `diff-note-validation-${editorSerial}`);
  const [invalid, setInvalid] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    for (const stale of document.querySelectorAll("dialog.diff-note-modal")) {
      if (stale !== textareaRef.current?.closest("dialog")) stale.remove();
    }
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!textarea.value.trim()) {
      setInvalid(true);
      textarea.focus();
      return;
    }
    upsertDiffNote(target, textarea.value);
    onClose(true);
  };

  return <WorkspaceDialog
    className="modal operation-modal diff-note-modal"
    titleId={titleId}
    onDismiss={() => onClose(false)}
    onSubmit={submit}
    initialFocus={() => textareaRef.current}
  >
    <h2 className="modal-title" id={titleId}>{editorTitle(target, Boolean(existing))}</h2>
    <div className="operation-body">
      <p className="diff-note-quote">
        <span className="diff-note-quote-line">{diffNoteLineLabel(target)}</span>
        {target.snippet ? <code className="diff-note-quote-text">{target.snippet}</code> : null}
      </p>
      <label className="operation-field">
        {t("diffNotes.field")}
        <textarea
          ref={textareaRef}
          name="body"
          rows={3}
          maxLength={DIFF_NOTE_BODY_LIMIT}
          placeholder={t("diffNotes.placeholder")}
          defaultValue={existing?.body ?? ""}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? validationId : undefined}
          onInput={() => setInvalid(false)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
      </label>
      <p className="notice notice-error" id={validationId} role="alert" hidden={!invalid}>
        {invalid ? t("diffNotes.needBody") : ""}
      </p>
      <div className="action-row">
        <Button type="submit" className="btn btn-small btn-primary">{t("diffNotes.save")}</Button>
        <Button className="btn btn-small btn-ghost" onClick={() => onClose(false)}>{t("cancel")}</Button>
        {existing && <Button className="btn btn-small btn-danger" onClick={() => {
          removeDiffNote(existing.id);
          onClose(true);
        }}>{t("diffNotes.remove")}</Button>}
      </div>
    </div>
  </WorkspaceDialog>;
}

export function DiffNoteCards({ target, onEdit }: { target: DiffNoteTarget; onEdit: (target: DiffNoteTarget) => void }) {
  const note = diffNoteForPin(target);
  if (!note) return null;
  const sending = diffNoteSending(note.id) || diffNoteSendOpen();
  return <div className="workspace-diff-note">
    <div className="diff-note-main" onClick={() => { if (!sending) onEdit(target); }}>
      <span className="diff-note-mark" aria-hidden="true">✎</span>
      <span className="diff-note-body">{note.body}</span>
    </div>
    <div className="diff-note-actions">
      <Button className="btn btn-small btn-ghost diff-note-action" aria-label={editorTitle(target, true)} disabled={sending} onClick={() => onEdit(target)}>
        {t("diffNotes.edit")}
      </Button>
      <Button className="btn btn-small btn-ghost diff-note-action" aria-label={t("diffNotes.remove")} disabled={sending} onClick={() => {
        removeDiffNote(note.id);
        render();
      }}>{t("diffNotes.remove")}</Button>
    </div>
  </div>;
}

export function DiffNotesBar({ path, layer }: { path: string; layer: GitLayer }) {
  const count = diffNotesFor(path, layer).length;
  if (!count || !state.operationCapabilities.prompt_agent) return null;
  const sending = state.operationBusy || diffNoteSendOpen();
  const canSend = canPromptAgent(selectedAgent());
  return <div className="workspace-notes-bar">
    <span className="workspace-notes-count">{t("diffNotes.count", { count })}</span>
    {!canSend && <span className="workspace-notes-hint">{t("diffNotes.noAgent")}</span>}
    <Button
      className="btn btn-primary workspace-notes-send"
      disabled={!canSend || sending}
      onClick={() => void sendDiffNotesToAgent(path, layer)}
    >{sending ? t("diffNotes.sending") : t("diffNotes.send")}</Button>
  </div>;
}

export function openNoteEditorAllowed(target: DiffNoteTarget): boolean {
  const existing = diffNoteForPin(target);
  if (existing && diffNoteSending(existing.id)) return false;
  if (state.operationBusy) return false;
  return true;
}
