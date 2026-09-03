/**
 * Diff annotation notes: comments pinned to concrete git-diff lines, kept in
 * memory until they are batched into ONE PromptAgent call. Composing all
 * notes into a single prompt keeps the revision coherent (one request, one
 * reply); there is deliberately no one-comment-per-RPC path.
 *
 * Notes are owned by the session + pane + diff revision that produced them.
 * A send only removes the note IDs captured for that request.
 */
import { t } from "./i18n";
import { fitOperationPrompt } from "./operations";
import type { DiffLine, GitLayer } from "./workspace";

export type DiffNoteSide = "old" | "new";

/** Where a note is pinned. At most one note per pin inside one owner. */
export type DiffNotePin = {
  path: string;
  layer: GitLayer;
  side: DiffNoteSide;
  line: number;
};

/** A pin plus the quoted source line, captured when the note is written. */
export type DiffNoteTarget = DiffNotePin & { snippet: string };

/** Session + pane + GitDiff.revision that a note belongs to. */
export type DiffNoteScope = {
  session: object;
  paneId: string;
  revision: string;
};

export type DiffNote = DiffNoteTarget & DiffNoteScope & { id: string; body: string };

/** One comment stays well under the 32 KiB prompt budget even in UTF-8. */
export const DIFF_NOTE_BODY_LIMIT = 2000;
export const DIFF_NOTE_SNIPPET_LIMIT = 120;

let notes: DiffNote[] = [];
let noteSerial = 0;
let scope: DiffNoteScope | null = null;
const sendingIds = new Set<string>();

export function adoptDiffNoteScope(next: DiffNoteScope | null): void {
  scope = next && next.paneId && next.revision ? next : null;
}

export function diffNoteScope(): DiffNoteScope | null {
  return scope;
}

function sameScope(note: DiffNote, owner: DiffNoteScope): boolean {
  return note.session === owner.session && note.paneId === owner.paneId && note.revision === owner.revision;
}

function visibleNotes(): DiffNote[] {
  return scope ? notes.filter((note) => sameScope(note, scope!)) : [];
}

export function diffNotes(): readonly DiffNote[] {
  return visibleNotes();
}

export function diffNotesFor(path: string, layer: GitLayer): DiffNote[] {
  return visibleNotes().filter((note) => note.path === path && note.layer === layer);
}

function samePin(note: DiffNotePin, target: DiffNotePin): boolean {
  return note.path === target.path && note.layer === target.layer && note.side === target.side && note.line === target.line;
}

export function diffNoteForPin(target: DiffNotePin): DiffNote | undefined {
  return visibleNotes().find((note) => samePin(note, target));
}

export function diffNoteSending(id: string): boolean {
  return sendingIds.has(id);
}

export function diffNoteSendOpen(): boolean {
  return sendingIds.size > 0;
}

/** Add or replace the note at the pin. Refuses without a bound owner or during send. */
export function upsertDiffNote(target: DiffNoteTarget, body: string): DiffNote | null {
  if (!scope) return null;
  const trimmed = body.trim().slice(0, DIFF_NOTE_BODY_LIMIT);
  if (!trimmed) return null;
  const existing = diffNoteForPin(target);
  if (existing) {
    if (sendingIds.has(existing.id)) return existing;
    existing.body = trimmed;
    existing.snippet = target.snippet;
    return existing;
  }
  const note: DiffNote = { ...target, ...scope, body: trimmed, id: `diff-note-${++noteSerial}` };
  notes = [...notes, note];
  return note;
}

export function removeDiffNote(id: string): void {
  if (sendingIds.has(id)) return;
  notes = notes.filter((note) => note.id !== id);
}

/** Drop only the captured ids. In-flight additions keep a different id and survive. */
export function removeDiffNotes(ids: readonly string[]): void {
  if (!ids.length) return;
  const drop = new Set(ids);
  notes = notes.filter((note) => !drop.has(note.id));
}

export function beginDiffNoteSend(ids: readonly string[]): void {
  sendingIds.clear();
  for (const id of ids) sendingIds.add(id);
}

export function endDiffNoteSend(): void {
  sendingIds.clear();
}

export function clearDiffNotes(path: string, layer: GitLayer): void {
  if (!scope) return;
  notes = notes.filter((note) => !sameScope(note, scope!) || note.path !== path || note.layer !== layer);
}

export function clearAllDiffNotes(): void {
  notes = [];
  sendingIds.clear();
  scope = null;
}

function diffSnippet(text: string): string {
  const compact = text.trim();
  if (compact.length <= DIFF_NOTE_SNIPPET_LIMIT) return compact;
  return `${compact.slice(0, DIFF_NOTE_SNIPPET_LIMIT)}…`;
}

/**
 * Only add / delete / context lines are noteable. Hunk and meta lines carry
 * no file content, and a null line number cannot be pinned.
 */
export function diffNoteTarget(path: string, layer: GitLayer, line: DiffLine): DiffNoteTarget | null {
  if (line.kind === "delete") {
    return line.oldLine === null ? null : { path, layer, side: "old", line: line.oldLine, snippet: diffSnippet(line.text) };
  }
  if (line.kind === "add" || line.kind === "context") {
    return line.newLine === null ? null : { path, layer, side: "new", line: line.newLine, snippet: diffSnippet(line.text) };
  }
  return null;
}

export type ComposedDiffNotes = { text: string; truncated: boolean; count: number };

function noteOrder(left: DiffNote, right: DiffNote): number {
  if (left.line !== right.line) return left.line - right.line;
  if (left.side !== right.side) return left.side === "old" ? -1 : 1;
  return left.id < right.id ? -1 : 1;
}

/**
 * Batch every note for one path/layer into a single prompt. Callers must
 * refuse when `truncated` is true instead of sending a clipped prompt.
 */
export function composeDiffNotesPrompt(
  path: string,
  layer: GitLayer,
  list: readonly DiffNote[] = diffNotesFor(path, layer),
): ComposedDiffNotes {
  const ordered = [...list].sort(noteOrder);
  const layerLabel = layer === "staged" ? t("workspace.staged") : t("workspace.worktree");
  const parts: string[] = [t("diffNotes.promptHeader", { path, layer: layerLabel }), ""];
  for (const note of ordered) {
    const side = note.side === "old" ? t("diffNotes.sideOld") : t("diffNotes.sideNew");
    parts.push(t("diffNotes.promptLine", { line: note.line, side }));
    if (note.snippet) parts.push(`> ${note.snippet}`);
    parts.push(note.body, "");
  }
  const composed = parts.join("\n").replace(/\n+$/u, "");
  const fitted = fitOperationPrompt(composed);
  return { text: fitted.text, truncated: fitted.truncated, count: ordered.length };
}
