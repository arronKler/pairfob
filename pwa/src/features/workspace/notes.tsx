import { ChevronRight, CircleCheck, PenLine, X } from "lucide-react";
import { cloneElement, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { canPromptAgent } from "../../lib/dashboard";
import {
  DIFF_NOTE_BODY_LIMIT,
  clearDiffNotes,
  diffHoldsNotes,
  diffNoteCounts,
  diffNoteForPin,
  diffNotePlace,
  diffNoteScope,
  diffNoteSendOpen,
  diffNoteSending,
  diffNotesFor,
  removeDiffNote,
  sameDiffNoteScope,
  upsertDiffNote,
  type DiffNote,
  type DiffNotePin,
  type DiffNoteScope,
  type DiffNoteTarget,
} from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import type { GitLayer } from "../../lib/workspace";
import { clearNotice, showStatus, visibleNotice } from "../../app/notices-store";
import { forgetSentDiffNotes, sentDiffNotesFor, sentNoteState, type SentDiffNote, type SentNoteState } from "../../lib/diff-notes-sent";
import { sendAllDiffNotesToAgent, sendDiffNotesToAgent } from "../../features/operations/controller";
import { operationBusy } from "../operations/capabilities-store";
import { useCapabilities } from "../operations/hooks";
import { useLiveSession } from "../computers/hooks";
import type { LiveSession } from "../../lib/protocol/client";
import { useAgentCard, usePaneId } from "../session/hooks";
import { usePresence } from "../../shared/react/use-presence";
import { MOTION_MS } from "../../shared/ui/dom/motion";
import { Button } from "../../shared/ui/primitives";
import { leaveWorkspace } from "./actions";
import { guardBackPress } from "./back-press";
import { returnLabel } from "./format";
import type { WorkspaceReturnView } from "./model";
import { settleWaitingNotes } from "./note-carry";
import { returnToNoteLine } from "./note-line-focus";
import { openWaitingNotes } from "./note-waiting";
import { watchSentNotes } from "./sent-notes";
import { bumpWorkspaceNotes } from "./store";
import { useKeyHint } from "./workspace-keys";

let editorSerial = 0;
/** The pin just saved; its card announces itself once, then this clears. */
let freshPin = "";
/** How long a note just pinned stands out: `note-fresh` (workspace-detail.scss). */
const NOTE_FRESH_MS = MOTION_MS.trace * 2;

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

/** Notes belong to one place (connection, Herdr session, pane, root) and file revision. */
export function sameNoteOwner(left: DiffNoteScope | null, right: DiffNoteScope | null): boolean {
  return sameDiffNoteScope(left, right);
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
 * What the editor under a line works with (`note-inline`): which note the pin
 * holds, the draft, validation, save and delete. `startWith` is a draft the
 * reader had already typed for this pin.
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
    // A note left on a line that changed is confirmed by saving it as it stands: there is something to save.
    unchanged: draft.trim() === (existing?.body ?? "").trim() && !existing?.drifted,
    textareaRef,
    submit,
    remove,
    /** The body field; the editor adds its own size and key handling. */
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

/** Ctrl/⌘+Enter saves from the body field. With Shift it is Send (`workspace-keys`), which saves on its way. */
export function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter" || event.shiftKey || !(event.metaKey || event.ctrlKey)) return false;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
  return true;
}

const SENT_STATE: Record<SentNoteState, "diffNotes.stateSent" | "diffNotes.stateWorking" | "diffNotes.stateAnswered"> = {
  sent: "diffNotes.stateSent",
  working: "diffNotes.stateWorking",
  answered: "diffNotes.stateAnswered",
};

/**
 * A note that was sent, under the line it was written on: what the agent was
 * told, and how far the agent is with it. It is a record and not a control;
 * the line still takes a new note.
 */
function SentNoteCard({ note }: { note: SentDiffNote }) {
  return <div className={`workspace-diff-note is-sent is-${note.state}`}>
    <div className="diff-note-main">
      <CircleCheck className="diff-note-mark" size={16} aria-hidden="true" />
      <span className="diff-note-body">{note.body}</span>
    </div>
    <p className="diff-note-sent-state">{t(SENT_STATE[note.state])}</p>
  </div>;
}

/**
 * The card of the note saved on a line, or the record of one that was sent
 * from it. Both are handed in by the line (`diff-line`): the card flashes on
 * its own clock, and a diff kept on screen while the next is read has to go on
 * showing the note it had, which the store has let go of by then.
 */
export function DiffNoteCards({ target, note, sent, onEdit }: {
  target: DiffNoteTarget; note: DiffNote | undefined; sent: SentDiffNote | undefined; onEdit: (target: DiffNoteTarget) => void;
}) {
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
    const timer = window.setTimeout(() => setFlash(false), NOTE_FRESH_MS + 100);
    return () => window.clearTimeout(timer);
  }, [flash]);
  if (!note) return sent ? <SentNoteCard note={sent} /> : null;
  const sending = diffNoteSending(note.id) || diffNoteSendOpen();
  return <div ref={card} className={`workspace-diff-note${fresh || flash ? " is-fresh" : ""}${sending ? " is-sending" : ""}`}>
    <div className="diff-note-main" onClick={() => { if (!sending) onEdit(target); }}>
      <PenLine className="diff-note-mark" size={16} aria-hidden="true" />
      <span className="diff-note-body">{note.body}</span>
    </div>
    {/* The file moved on and this line is not the one the note was written on: show that line, as it was. */}
    {note.drifted && <p className="diff-note-drift" role="note">
      <span>{t("diffNotes.drifted")}</span>
      {note.snippet ? <code>{note.snippet}</code> : null}
    </p>}
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
 * view the screen returns to (`returnView`). The receipt is the record of what
 * was sent for this file and layer (`diff-notes-sent`): it says how far the
 * agent is, waits for the reader when they come back to the diff, and goes
 * when they dismiss it or write the next note. `beside` is the inspector: the
 * session is already next to the diff, so the receipt offers no way back and
 * the reader stays where they are.
 *
 * The bar comes up from below when it has something to say, and goes the way
 * it came once it has nothing left: it is kept for that, as it last stood and
 * out of reach.
 */
export function DiffNotesBar(props: NotesBarProps) {
  // Subscribed snapshots: the bar re-renders with capability, busy and pane
  // changes instead of reading one-shot published copies during render.
  const capabilities = useCapabilities();
  // The open pane is the one whose agent receives the notes, as before.
  const agent = useAgentCard(usePaneId());
  useEffect(watchSentNotes, []);
  const sendKey = useKeyHint("sendNotes");
  const live = useLiveSession();
  const bar = notesBar(props, { capabilities, agent, sendKey, live });
  const last = useRef<NotesBar | null>(null);
  if (bar) last.current = bar;
  const { leaving } = usePresence(bar !== null, MOTION_MS.element);
  if (bar || !leaving || !last.current) return bar;
  return cloneElement(last.current, { className: `${last.current.props.className} is-leaving`, inert: true });
}

type NotesBarProps = { path: string; layer: GitLayer; paneId: string; beside?: boolean; returnView?: WorkspaceReturnView };
type NotesBar = ReactElement<{ className: string; inert?: boolean }>;

/** The bar for what the stores hold now; null when there is nothing to say. */
function notesBar({ path, layer, paneId, beside = false, returnView = "guided" }: NotesBarProps, { capabilities, agent, sendKey, live }: {
  capabilities: ReturnType<typeof useCapabilities>; agent: ReturnType<typeof useAgentCard>;
  sendKey: ReturnType<typeof useKeyHint>; live: LiveSession | null;
}): NotesBar | null {
  const count = diffNotesFor(path, layer).length;
  if (!capabilities.operationCapabilities.prompt_agent) return null;
  const place = diffNotePlace(live, paneId);
  const sent = sentDiffNotesFor(place, path, layer);
  const state = sentNoteState(sent);
  // Notes waiting elsewhere: on other files, and on this file's other layer, which is no other file.
  const counts = diffNoteCounts(live, paneId);
  counts.delete(`${layer}:${path}`);
  const elsewhere = counts.size;
  const otherFiles = new Set([...counts.keys()].map((key) => key.slice(key.indexOf(":") + 1)).filter((other) => other !== path)).size;
  if (!count && state) {
    return <div className={`workspace-notes-bar is-sent is-${state}`} role="status">
      <CircleCheck className="workspace-notes-ok" size={22} aria-hidden="true" />
      <span className="workspace-notes-copy">
        <strong>{t("diffNotes.sentReceipt", { count: sent.length })}</strong>
        <small>{t(state === "sent" ? "diffNotes.sentDetail" : SENT_STATE[state])}</small>
      </span>
      {/* The session's key row comes up under this chip: a doubled press must not type into the program. */}
      {!beside && <Button className="workspace-chip workspace-notes-terminal" onClick={(event) => {
        guardBackPress(event);
        leaveWorkspace();
      }}>{returnLabel(returnView)}</Button>}
      <Button className="icon-btn workspace-notes-dismiss" aria-label={t("diffNotes.dismissReceipt")} onClick={() => {
        forgetSentDiffNotes(place, path, layer);
        bumpWorkspaceNotes();
      }}>
        <X size={18} aria-hidden="true" />
      </Button>
    </div>;
  }
  if (!count && !elsewhere) return null;
  const sending = capabilities.operationBusy || diffNoteSendOpen();
  const canSend = canPromptAgent(agent);
  const layerName = layer === "staged" ? t("workspace.staged") : t("workspace.worktree");
  const otherLayerName = layer === "staged" ? t("workspace.worktree") : t("workspace.staged");
  // The file's change is gone or its patch is cut short: nothing on screen holds these notes, so the bar is where they are answered.
  const unheld = count > 0 && !diffHoldsNotes(path, layer);
  const detail = !canSend ? t("diffNotes.noAgent")
    : unheld ? t("diffNotes.unheld")
    : otherFiles ? t("diffNotes.otherFiles", { count: otherFiles })
    : elsewhere ? t("diffNotes.otherLayer", { layer: otherLayerName })
    : t("diffNotes.thisFile", { layer: layerName });
  const send = async (all: boolean) => {
    const before = diffNotesFor(path, layer).length;
    await (all ? sendAllDiffNotesToAgent(settleWaitingNotes) : sendDiffNotesToAgent(path, layer));
    if (before && !diffNotesFor(path, layer).length && beside) yieldSentNotice();
  };
  // Nothing waits on this file: the bar is only the way to the notes that wait elsewhere.
  if (!count) {
    return <div className="workspace-notes-bar is-elsewhere">
      <WaitingElsewhere>
        <strong className="workspace-notes-count">{otherFiles ? t("diffNotes.otherFiles", { count: otherFiles }) : t("diffNotes.otherLayer", { layer: otherLayerName })}</strong>
        <small className={canSend ? "" : "workspace-notes-hint"}>{canSend ? t("diffNotes.where") : t("diffNotes.noAgent")}<ChevronRight size={12} aria-hidden="true" /></small>
      </WaitingElsewhere>
      {canSend && <Button className="workspace-chip workspace-notes-all" disabled={sending} onClick={() => void send(true)}>
        {t("diffNotes.sendAll")}
      </Button>}
    </div>;
  }
  const copy = <>
    <strong className="workspace-notes-count">{t("diffNotes.pending", { count })}</strong>
    <small className={canSend && !unheld ? "" : "workspace-notes-hint"}>{detail}{elsewhere > 0 && <ChevronRight size={12} aria-hidden="true" />}</small>
  </>;
  return <div className="workspace-notes-bar">
    {/* Notes wait elsewhere too: the words that say so lead to where, and one prompt can carry them all. */}
    {elsewhere > 0 ? <WaitingElsewhere>{copy}</WaitingElsewhere> : <span className="workspace-notes-copy">{copy}</span>}
    {unheld && <Button className="workspace-chip workspace-notes-discard" disabled={sending} onClick={() => {
      clearDiffNotes(path, layer);
      bumpWorkspaceNotes();
      showStatus(t("diffNotes.discarded", { count }));
    }}>{t("diffNotes.discard")}</Button>}
    {elsewhere > 0 && canSend && <Button className="workspace-chip workspace-notes-all" disabled={sending} onClick={() => void send(true)}>
      {t("diffNotes.sendAll")}
    </Button>}
    <Button
      className="btn btn-primary workspace-notes-send"
      disabled={!canSend || sending}
      aria-busy={sending || undefined}
      aria-keyshortcuts={sendKey.keys}
      title={sendKey.keys ? sendKey.title(t("diffNotes.send")) : undefined}
      onClick={() => void send(false)}
    >{sending ? <><span className="spinner" aria-hidden="true" />{t("diffNotes.sending")}</> : t("diffNotes.send")}</Button>
  </div>;
}

/** The bar's words, as the way to the files whose notes wait (`note-waiting`). */
function WaitingElsewhere({ children }: { children: ReactNode }) {
  return <Button className="workspace-notes-copy workspace-notes-where" aria-haspopup="dialog" onClick={(event) => openWaitingNotes(event.currentTarget)}>
    {children}
  </Button>;
}

export function openNoteEditorAllowed(target: DiffNoteTarget): boolean {
  const existing = diffNoteForPin(target);
  if (existing && diffNoteSending(existing.id)) return false;
  if (operationBusy()) return false;
  return true;
}
