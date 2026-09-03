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

export function diffLineHasNote(target: DiffNoteTarget): boolean {
  return diffNoteForPin(target) !== undefined;
}

/** Tap target for an annotated diff line: edit the existing note or add one. */
export function openDiffNoteEditor(target: DiffNoteTarget): void {
  const existing = diffNoteForPin(target);
  if (existing && diffNoteSending(existing.id)) return;
  for (const stale of document.querySelectorAll("dialog.diff-note-modal")) stale.remove();
  const dialog = node("dialog", "modal operation-modal diff-note-modal");
  const form = node("form");
  form.method = "dialog";
  form.append(node("h2", "modal-title", existing ? t("diffNotes.editTitle") : t("diffNotes.addTitle")));
  const body = node("div", "operation-body");
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
  if (target.snippet) body.append(node("p", "operation-hint", `> ${target.snippet}`));
  const validation = node("p", "notice notice-error");
  validation.setAttribute("role", "alert");
  validation.hidden = true;
  body.append(validation);
  const actions = node("div", "action-row");
  const save = node("button", "btn btn-small btn-primary", t("diffNotes.save"));
  save.type = "submit";
  actions.append(save);
  if (existing) {
    const noteId = existing.id;
    actions.append(button(t("diffNotes.remove"), "btn btn-small btn-danger", () => {
      removeDiffNote(noteId);
      dialog.close("remove");
    }));
  }
  actions.append(button(t("cancel"), "btn btn-small btn-ghost", () => dialog.close("cancel")));
  body.append(actions);
  form.append(body);
  dialog.append(form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!textarea.value.trim()) {
      validation.textContent = t("diffNotes.needBody");
      validation.hidden = false;
      textarea.focus();
      return;
    }
    upsertDiffNote(target, textarea.value);
    dialog.close("save");
  });
  const openedAt = performance.now();
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (performance.now() - openedAt < 400) return;
    dialog.close("cancel");
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    render();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  textarea.focus();
}

/** Note cards pinned to one diff line; rendered right under that line. */
export function diffNoteCards(target: DiffNoteTarget): HTMLElement[] {
  const note = diffNoteForPin(target);
  if (!note) return [];
  const card = node("div", "workspace-diff-note");
  const mark = node("span", "diff-note-mark", "✎");
  mark.setAttribute("aria-hidden", "true");
  const actions = node("div", "diff-note-actions");
  const edit = button(t("diffNotes.edit"), "btn btn-small btn-ghost diff-note-action", () => openDiffNoteEditor(target));
  edit.setAttribute("aria-label", t("diffNotes.editTitle"));
  const noteId = note.id;
  const remove = button(t("diffNotes.remove"), "btn btn-small btn-ghost diff-note-action", () => {
    removeDiffNote(noteId);
    render();
  });
  remove.setAttribute("aria-label", t("diffNotes.remove"));
  actions.append(edit, remove);
  card.append(mark, node("span", "diff-note-body", note.body), actions);
  return [card];
}

/**
 * The batch send bar. Hidden without notes or without the prompt_agent
 * capability; disabled (with a reason) when the selected pane has no agent.
 */
export function diffNotesBar(path: string, layer: GitLayer): HTMLElement | null {
  const count = diffNotesFor(path, layer).length;
  if (!count || !state.operationCapabilities.prompt_agent) return null;
  const bar = node("div", "workspace-notes-bar");
  bar.append(node("span", "workspace-notes-count", t("diffNotes.count", { count })));
  if (!canPromptAgent(selectedAgent())) bar.append(node("span", "workspace-notes-hint", t("diffNotes.noAgent")));
  const send = button(t("diffNotes.send"), "btn btn-primary workspace-notes-send", () => void sendDiffNotesToAgent(path, layer));
  send.disabled = !canPromptAgent(selectedAgent()) || state.operationBusy || diffNoteSendOpen();
  bar.append(send);
  return bar;
}
