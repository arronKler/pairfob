/**
 * Diff annotation UI: the compact line editor dialog, note cards rendered
 * under annotated diff lines, and the "send to agent" bar. Pure model and
 * prompt composition live in lib/diff-notes.
 */
import { canPromptAgent } from "../lib/dashboard";
import {
  DIFF_NOTE_BODY_LIMIT,
  diffNoteForPin,
  diffNoteSendOpen,
  diffNoteSending,
  diffNotesFor,
  removeDiffNote,
  upsertDiffNote,
  type DiffNoteTarget,
} from "../lib/diff-notes";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import type { GitLayer } from "../lib/workspace";
import { sendDiffNotesToAgent } from "../live-operations";
import { render } from "../paint";
import { selectedAgent, state } from "../state";

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

function clearValidation(textarea: HTMLTextAreaElement, validation: HTMLElement): void {
  validation.hidden = true;
  textarea.removeAttribute("aria-invalid");
  textarea.removeAttribute("aria-describedby");
}

/** Tap target for an annotated diff line: edit the existing note or add one. */
export function openDiffNoteEditor(target: DiffNoteTarget): void {
  const existing = diffNoteForPin(target);
  if (existing && diffNoteSending(existing.id)) return;
  for (const stale of document.querySelectorAll("dialog.diff-note-modal")) stale.remove();
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = node("dialog", "modal operation-modal diff-note-modal");
  const form = node("form");
  form.method = "dialog";
  const titleID = `diff-note-title-${++editorSerial}`;
  const heading = node("h2", "modal-title", editorTitle(target, Boolean(existing)));
  heading.id = titleID;
  dialog.setAttribute("aria-labelledby", titleID);
  const body = node("div", "operation-body");
  const quote = node("p", "diff-note-quote");
  quote.append(node("span", "diff-note-quote-line", diffNoteLineLabel(target)));
  if (target.snippet) quote.append(node("code", "diff-note-quote-text", target.snippet));
  body.append(quote);
  const field = node("label", "operation-field");
  field.append(document.createTextNode(t("diffNotes.field")));
  const textarea = node("textarea");
  textarea.name = "body";
  textarea.rows = 3;
  textarea.maxLength = DIFF_NOTE_BODY_LIMIT;
  textarea.placeholder = t("diffNotes.placeholder");
  textarea.value = existing?.body ?? "";
  field.append(textarea);
  body.append(field);
  const validation = node("p", "notice notice-error");
  validation.id = `diff-note-validation-${editorSerial}`;
  validation.setAttribute("role", "alert");
  validation.hidden = true;
  body.append(validation);
  const actions = node("div", "action-row");
  const save = node("button", "btn btn-small btn-primary", t("diffNotes.save"));
  save.type = "submit";
  actions.append(save, button(t("cancel"), "btn btn-small btn-ghost", () => dialog.close("cancel")));
  if (existing) {
    const noteId = existing.id;
    actions.append(button(t("diffNotes.remove"), "btn btn-small btn-danger", () => {
      removeDiffNote(noteId);
      dialog.close("remove");
    }));
  }
  body.append(actions);
  form.append(heading, body);
  dialog.append(form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!textarea.value.trim()) {
      validation.textContent = t("diffNotes.needBody");
      validation.hidden = false;
      textarea.setAttribute("aria-invalid", "true");
      textarea.setAttribute("aria-describedby", validation.id);
      textarea.focus();
      return;
    }
    upsertDiffNote(target, textarea.value);
    dialog.close("save");
  });
  textarea.addEventListener("input", () => clearValidation(textarea, validation));
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    form.requestSubmit();
  });
  const openedAt = performance.now();
  const dismiss = (): void => {
    if (performance.now() - openedAt < 400) return;
    dialog.close("cancel");
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    dismiss();
  });
  dialog.addEventListener("close", () => {
    const changed = dialog.returnValue === "save" || dialog.returnValue === "remove";
    dialog.remove();
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
    if (changed) render();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  textarea.focus();
}

/** Note cards pinned to one diff line; rendered right under that line. */
export function diffNoteCards(target: DiffNoteTarget): HTMLElement[] {
  const note = diffNoteForPin(target);
  if (!note) return [];
  const sending = diffNoteSending(note.id) || diffNoteSendOpen();
  const card = node("div", "workspace-diff-note");
  const main = node("div", "diff-note-main");
  const mark = node("span", "diff-note-mark", "✎");
  mark.setAttribute("aria-hidden", "true");
  const body = node("span", "diff-note-body", note.body);
  main.append(mark, body);
  main.addEventListener("click", () => {
    if (!sending) openDiffNoteEditor(target);
  });
  const actions = node("div", "diff-note-actions");
  const edit = button(t("diffNotes.edit"), "btn btn-small btn-ghost diff-note-action", () => openDiffNoteEditor(target));
  edit.setAttribute("aria-label", editorTitle(target, true));
  edit.disabled = sending;
  const noteId = note.id;
  const remove = button(t("diffNotes.remove"), "btn btn-small btn-ghost diff-note-action", () => {
    removeDiffNote(noteId);
    render();
  });
  remove.setAttribute("aria-label", t("diffNotes.remove"));
  remove.disabled = sending;
  actions.append(edit, remove);
  card.append(main, actions);
  return [card];
}

/**
 * The batch send bar. Hidden without notes or without the prompt_agent
 * capability; disabled (with a reason) when the selected pane has no agent.
 */
export function diffNotesBar(path: string, layer: GitLayer): HTMLElement | null {
  const count = diffNotesFor(path, layer).length;
  if (!count || !state.operationCapabilities.prompt_agent) return null;
  const sending = state.operationBusy || diffNoteSendOpen();
  const canSend = canPromptAgent(selectedAgent());
  const bar = node("div", "workspace-notes-bar");
  bar.append(node("span", "workspace-notes-count", t("diffNotes.count", { count })));
  if (!canSend) bar.append(node("span", "workspace-notes-hint", t("diffNotes.noAgent")));
  const send = button(
    sending ? t("diffNotes.sending") : t("diffNotes.send"),
    "btn btn-primary workspace-notes-send",
    () => void sendDiffNotesToAgent(path, layer),
  );
  send.disabled = !canSend || sending;
  bar.append(send);
  return bar;
}
