import { CircleCheck, PenLine, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { canPromptAgent } from "../../lib/dashboard";
import {
  DIFF_NOTE_BODY_LIMIT,
  diffNoteCounts,
  diffNoteForPin,
  diffNoteScope,
  diffNoteSendOpen,
  diffNoteSending,
  diffNotesFor,
  removeDiffNote,
  upsertDiffNote,
  type DiffNotePin,
  type DiffNoteScope,
  type DiffNoteTarget,
} from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import type { GitLayer } from "../../lib/workspace";
import { clearNotice, showStatus, visibleNotice } from "../../app/notices-store";
import { sendDiffNotesToAgent } from "../../features/operations/controller";
import { operationBusy } from "../operations/capabilities-store";
import { useCapabilities } from "../operations/hooks";
import { liveSession } from "../computers/catalog-store";
import { useDashboard } from "../dashboard/hooks";
import { useSession } from "../session/hooks";
import { agentFromDashboardSnapshot } from "../session/agents";
import { useDeskCancel } from "../../shared/ui/overlay/desk-form";
import { DeskCancel, DeskClose } from "../../shared/ui/overlay/modal";
import { Button } from "../../shared/ui/primitives";
import { leaveWorkspace } from "./actions";
import { guardBackPress } from "./back-press";
import { returnLabel } from "./format";
import type { WorkspaceReturnView } from "./model";
import { WorkspaceDialog } from "./modal";
import { returnToNoteLine } from "./note-line-focus";
import { bumpWorkspaceNotes } from "./store";

let editorSerial = 0;
/** The pin just saved; its card announces itself once, then this clears. */
let freshPin = "";

/** One line of one side of one layer of one file: where a note is pinned. */
export const diffNotePinKey = (pin: DiffNotePin) => `${pin.layer}:${pin.side}:${pin.line}:${pin.path}`;

export function diffLineHasNote(target: DiffNoteTarget): boolean {
  return diffNoteForPin(target) !== undefined;
}

export function diffNoteLineLabel(target: Pick<DiffNoteTarget, "line" | "side">): string {
  const side = target.side === "old" ? t("diffNotes.sideOld") : t("diffNotes.sideNew");
  return t("diffNotes.promptLine", { line: target.line, side });
}

export function diffNoteEditorTitle(target: DiffNoteTarget, editing: boolean): string {
  return t(editing ? "diffNotes.editTitle" : "diffNotes.addTitle", { line: target.line });
}

/** Notes belong to one session, pane and file revision. */
export function sameNoteOwner(left: DiffNoteScope | null, right: DiffNoteScope | null): boolean {
  return Boolean(left && right && left.session === right.session && left.paneId === right.paneId && left.revision === right.revision);
}

/**
 * Save `body` at the pin for the scope the reader wrote it in. False when the
 * diff moved on underneath them or the body is blank; nothing is saved then.
 * `replaces` is whether they were editing a saved note.
 */
export function saveDiffNote(target: DiffNoteTarget, body: string, owner: DiffNoteScope | null, replaces: boolean): boolean {
  if (!sameNoteOwner(owner, diffNoteScope())) return false;
  if (!upsertDiffNote(target, body, owner)) return false;
  freshPin = diffNotePinKey(target);
  const count = diffNotesFor(target.path, target.layer).length;
  showStatus(replaces ? t("diffNotes.updated") : t("diffNotes.added", { count }));
  return true;
}

/**
 * What the two editors share: which note the pin holds, the draft, validation,
 * save and delete. The sheet on the workspace screen and the form the
 * inspector opens under the line differ only in how they are laid out.
 * `startWith` is a draft the reader had already typed for this pin.
 */
export function useNoteEditor(target: DiffNoteTarget, onClose: (changed: boolean) => void, startWith?: string) {
  const [owner] = useState(() => diffNoteScope());
  const existing = sameNoteOwner(owner, diffNoteScope()) ? diffNoteForPin(target) : undefined;
  const [titleId] = useState(() => `diff-note-title-${++editorSerial}`);
  const [validationId] = useState(() => `diff-note-validation-${editorSerial}`);
  const [invalid, setInvalid] = useState(false);
  const [initial] = useState(() => startWith || (existing?.body ?? ""));
  const [draft, setDraft] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!textarea.value.trim()) {
      setInvalid(true);
      textarea.focus();
      return;
    }
    onClose(saveDiffNote(target, textarea.value, owner, Boolean(existing)));
  };
  const remove = existing ? () => {
    if (!sameNoteOwner(owner, diffNoteScope())) {
      onClose(false);
      return;
    }
    removeDiffNote(existing.id);
    showStatus(t("diffNotes.removed"));
    onClose(true);
  } : undefined;

  return {
    existing,
    titleId,
    validationId,
    invalid,
    draft,
    unchanged: draft.trim() === (existing?.body ?? "").trim(),
    textareaRef,
    submit,
    remove,
    /** The body field; each editor adds its own size and key handling. */
    field: {
      ref: textareaRef,
      id: `${titleId}-body`,
      className: "diff-note-body-field",
      name: "body",
      maxLength: DIFF_NOTE_BODY_LIMIT,
      placeholder: t("diffNotes.placeholder"),
      defaultValue: initial,
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? validationId : undefined,
      onInput: (event: FormEvent<HTMLTextAreaElement>) => { setInvalid(false); setDraft(event.currentTarget.value); },
    },
  };
}

/** Ctrl/⌘+Enter saves from the body field, in either editor. */
export function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return false;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
  return true;
}

/** The sheet's bar (Cancel · title · Save); in the desk form the title alone, as every desk dialog has it. */
function NoteHead({ titleId, label, title, unchanged, onCancel }: {
  titleId: string; label: string; title: string; unchanged: boolean; onCancel: () => void;
}) {
  const heading = <h2 className="modal-title" id={titleId} aria-label={label}>{title}</h2>;
  if (useDeskCancel()) return heading;
  return <div className="text-edit-head">
    <Button className="text-edit-action" onClick={onCancel}>{t("cancel")}</Button>
    {heading}
    <button type="submit" className="text-edit-action text-edit-save" disabled={unchanged}>{t("text.save")}</button>
  </div>;
}

/**
 * What the desk form adds under the field: the footer every desk dialog ends
 * with, then the corner control. Cancel is the answer that drops the words. The
 * corner is the other way out, the one Escape takes: it puts the note away
 * without an answer, so a half-written one waits under its line. It is named
 * for that while there are words to keep; with none it only closes. The sheet
 * draws neither: it has its bar.
 */
function NoteDeskFooter({ unchanged, keeps, onSetAside }: { unchanged: boolean; keeps: boolean; onSetAside: () => void }) {
  if (!useDeskCancel()) return null;
  const leave = t(keeps ? "diffNotes.setAside" : "close");
  return <>
    <div className="desk-actions">
      <DeskCancel />
      <button type="submit" className="desk-action is-primary text-edit-save" disabled={unchanged}>{t("text.save")}</button>
    </div>
    <DeskClose onDismiss={onSetAside} label={leave} />
  </>;
}

/**
 * A text-edit sheet: Cancel and Save sit above the field so the keyboard never
 * covers them, and the quoted line stands in for the row the keyboard hides.
 * The backdrop does not dismiss it, so a stray tap never drops a draft.
 * `startWith` is what the reader had already typed for this pin, and `onDraft`
 * hears what they type here, so the note outlives a sheet that goes away
 * without an answer (`note-sheet`). Escape is such a leaving (`onSetAside`);
 * Cancel is the answer that drops the words.
 *
 * Opened with a mouse or the keyboard beside the list it is the desk form
 * instead: the title, the field, then Cancel and Save as its footer and the
 * corner control last, which leaves the way Escape does.
 */
export function DiffNoteEditor({ target, onClose, startWith, onDraft, onSetAside }: {
  target: DiffNoteTarget; onClose: (changed: boolean) => void; startWith?: string; onDraft?: (draft: string) => void;
  onSetAside?: () => void;
}) {
  const { existing, titleId, validationId, invalid, draft, unchanged, textareaRef, submit, remove, field } = useNoteEditor(target, onClose, startWith);
  const cancel = useCallback(() => onClose(false), [onClose]);

  useLayoutEffect(() => {
    for (const stale of document.querySelectorAll("dialog.diff-note-modal")) {
      if (stale !== textareaRef.current?.closest("dialog")) stale.remove();
    }
    // Picked up where they stopped: the caret goes after their last word.
    const textarea = textareaRef.current;
    if (startWith && textarea) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  return <WorkspaceDialog
    className="modal text-edit diff-note-modal"
    titleId={titleId}
    onDismiss={cancel}
    onEscape={onSetAside}
    onSubmit={submit}
    initialFocus={() => textareaRef.current}
    keepOnBackdrop
  >
    <NoteHead titleId={titleId} label={diffNoteEditorTitle(target, Boolean(existing))} title={t("diffNotes.lineTitle", { line: target.line })}
      unchanged={unchanged} onCancel={cancel} />
    <p className={`diff-note-quote side-${target.side}`}>
      <span className="diff-note-quote-line">{diffNoteLineLabel(target)}</span>
      {target.snippet ? <code className="diff-note-quote-text">{target.snippet}</code> : null}
    </p>
    <label className="text-edit-label" htmlFor={field.id}>{t("diffNotes.field")}</label>
    <textarea {...field} rows={4} onKeyDown={submitOnModEnter}
      onInput={(event) => {
        field.onInput(event);
        onDraft?.(event.currentTarget.value);
      }} />
    <p className="notice notice-error" id={validationId} role="alert" hidden={!invalid}>
      {invalid ? t("diffNotes.needBody") : ""}
    </p>
    <div className="diff-note-foot">
      <span className="diff-note-count">{`${draft.length} / ${DIFF_NOTE_BODY_LIMIT}`}</span>
      {remove && <Button className="diff-note-remove" onClick={remove}>{t("diffNotes.deleteNote")}</Button>}
    </div>
    <NoteDeskFooter unchanged={unchanged} keeps={!unchanged && draft.trim() !== ""} onSetAside={onSetAside ?? cancel} />
  </WorkspaceDialog>;
}

export function DiffNoteCards({ target, onEdit }: { target: DiffNoteTarget; onEdit: (target: DiffNoteTarget) => void }) {
  const note = diffNoteForPin(target);
  const card = useRef<HTMLDivElement>(null);
  const fresh = Boolean(note) && freshPin === diffNotePinKey(target);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!fresh) return;
    freshPin = "";
    setFlash(true);
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [fresh]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(false), 1200);
    return () => window.clearTimeout(timer);
  }, [flash]);
  if (!note) return null;
  const sending = diffNoteSending(note.id) || diffNoteSendOpen();
  return <div ref={card} className={`workspace-diff-note${fresh || flash ? " is-fresh" : ""}${sending ? " is-sending" : ""}`}>
    <div className="diff-note-main" onClick={() => { if (!sending) onEdit(target); }}>
      <PenLine className="diff-note-mark" size={16} aria-hidden="true" />
      <span className="diff-note-body">{note.body}</span>
    </div>
    <div className="diff-note-actions">
      <Button className="btn btn-small btn-ghost diff-note-action" aria-label={diffNoteEditorTitle(target, true)} disabled={sending} onClick={() => onEdit(target)}>
        {t("diffNotes.edit")}
      </Button>
      <Button className="btn btn-small btn-ghost diff-note-action" aria-label={t("diffNotes.remove")} disabled={sending} onClick={() => {
        // The card goes with its note, and this button with the card.
        returnToNoteLine(diffNotePinKey(target));
        removeDiffNote(note.id);
        bumpWorkspaceNotes();
        showStatus(t("diffNotes.removed"));
      }}>{t("diffNotes.remove")}</Button>
    </div>
  </div>;
}

/**
 * Beside the session the receipt is the confirmation, in the column where the
 * reader pressed Send. The banner the send raised sits in the session column
 * right next to it and would say the same thing twice, so it steps down before
 * it is ever painted. On the screen the two are a page apart and both stay.
 */
function yieldSentNotice(): void {
  const notice = visibleNotice();
  if (notice?.tone === "status" && notice.text === t("diffNotes.sent")) clearNotice();
}

/**
 * Pending comments for this file and layer, then — once sent — a receipt with
 * the way back to the session where the agent's work shows up, named for the
 * view the screen returns to (`returnView`). The parent keys this bar by file
 * and layer, so a receipt never follows the reader to another diff. `beside`
 * is the inspector: the session is already next to the diff, so the receipt
 * offers no way back and the reader stays where they are.
 */
export function DiffNotesBar({ path, layer, paneId, beside = false, returnView = "guided" }: {
  path: string; layer: GitLayer; paneId: string; beside?: boolean; returnView?: WorkspaceReturnView;
}) {
  // Subscribed snapshots: the bar re-renders with capability, busy and pane
  // changes instead of reading one-shot published copies during render.
  const capabilities = useCapabilities();
  const dashboard = useDashboard();
  const session = useSession();
  const [receipt, setReceipt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const count = diffNotesFor(path, layer).length;
  if (!capabilities.operationCapabilities.prompt_agent) return null;
  if (!count && receipt) {
    return <div className="workspace-notes-bar is-sent" role="status">
      <CircleCheck className="workspace-notes-ok" size={22} aria-hidden="true" />
      <span className="workspace-notes-copy">
        <strong>{t("diffNotes.sentReceipt", { count: receipt })}</strong>
        <small>{t("diffNotes.sentDetail")}</small>
      </span>
      {/* The session's key row comes up under this chip: a doubled press must not type into the program. */}
      {!beside && <Button className="workspace-chip workspace-notes-terminal" onClick={(event) => {
        guardBackPress(event);
        leaveWorkspace();
      }}>{returnLabel(returnView)}</Button>}
      <Button className="icon-btn workspace-notes-dismiss" aria-label={t("diffNotes.dismissReceipt")} onClick={() => setReceipt(0)}>
        <X size={18} aria-hidden="true" />
      </Button>
    </div>;
  }
  if (!count) return null;
  const sending = capabilities.operationBusy || diffNoteSendOpen();
  const canSend = canPromptAgent(agentFromDashboardSnapshot(dashboard, session.paneId));
  const counts = diffNoteCounts(liveSession(), paneId);
  counts.delete(`${layer}:${path}`);
  const others = counts.size;
  const layerName = layer === "staged" ? t("workspace.staged") : t("workspace.worktree");
  const detail = !canSend ? t("diffNotes.noAgent")
    : others ? t("diffNotes.otherFiles", { count: others })
    : t("diffNotes.thisFile", { layer: layerName });
  const send = async () => {
    const before = diffNotesFor(path, layer).length;
    await sendDiffNotesToAgent(path, layer);
    if (!mounted.current || !before || diffNotesFor(path, layer).length) return;
    setReceipt(before);
    if (beside) yieldSentNotice();
  };
  return <div className="workspace-notes-bar">
    <span className="workspace-notes-copy">
      <strong className="workspace-notes-count">{t("diffNotes.pending", { count })}</strong>
      <small className={canSend ? "" : "workspace-notes-hint"}>{detail}</small>
    </span>
    <Button
      className="btn btn-primary workspace-notes-send"
      disabled={!canSend || sending}
      aria-busy={sending || undefined}
      onClick={() => void send()}
    >{sending ? <><span className="spinner" aria-hidden="true" />{t("diffNotes.sending")}</> : t("diffNotes.send")}</Button>
  </div>;
}

export function openNoteEditorAllowed(target: DiffNoteTarget): boolean {
  const existing = diffNoteForPin(target);
  if (existing && diffNoteSending(existing.id)) return false;
  if (operationBusy()) return false;
  return true;
}
