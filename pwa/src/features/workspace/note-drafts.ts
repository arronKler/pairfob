import { useSyncExternalStore } from "react";
import { diffNoteForPin, diffNoteScope, type DiffNoteScope, type DiffNoteTarget } from "../../lib/diff-notes";
import { diffNotePinKey, sameNoteOwner } from "./notes";

/**
 * Line notes being written, kept by the pane and diff they are written on.
 *
 * A diff is shown two ways: in the inspector beside the session, where a note
 * is edited in place under its line (`note-inline`), and on the workspace
 * screen, where it is edited in a sheet (`note-sheet`). Which of the two the
 * reader is looking at changes with the window's width, a rotation and the
 * files button, and the diff itself changes with every step through the
 * review. What they were typing must not go with any of that, so it lives here
 * and neither editor owns it: each shows the note this module holds for the
 * diff on screen, and saving or cancelling in either one lets go of it for
 * both.
 *
 * Each diff has at most one, and it belongs to the note scope it was opened in
 * (session, pane and file revision), so it never shows up on another pane's
 * diff or on a file that changed underneath it.
 */
export type OpenNote = {
  owner: DiffNoteScope;
  target: DiffNoteTarget;
  /** What the reader typed; null until they type. */
  draft: string | null;
  /** Opened in place by a press just now, so the field takes focus when it mounts. */
  fresh: boolean;
  /**
   * Left with Escape while it held words: the editor is closed and the note
   * waits under its line as a card until the reader presses it.
   */
  aside: boolean;
};

/** By pane and diff. */
const openNotes = new Map<string, OpenNote>();
let version = 0;
const listeners = new Set<() => void>();

function published(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function hold(key: string, note: OpenNote): void {
  // Notes of a session that is gone have no diff to come back to.
  for (const [stale, other] of openNotes) if (other.owner.session !== note.owner.session) openNotes.delete(stale);
  openNotes.set(key, note);
}

/** The typed text differs from what the pin has saved. */
export function unsaved(note: OpenNote): boolean {
  return note.draft !== null && note.draft.trim() !== (diffNoteForPin(note.target)?.body ?? "").trim();
}

/** Words the reader would lose: an emptied field holds none. */
export function halfWritten(note: OpenNote): boolean {
  return unsaved(note) && note.draft!.trim() !== "";
}

/** A diff's place in the store and the note open on it (`diffKey` is its file and layer). */
export type HeldNote = {
  key: string;
  /** Null while no diff is on screen to write on. */
  owner: DiffNoteScope | null;
  note: OpenNote | null;
};

export function useHeldNote(diffKey: string): HeldNote {
  useSyncExternalStore(subscribe, () => version);
  const owner = diffKey ? diffNoteScope() : null;
  const key = owner ? `${owner.paneId}\n${diffKey}` : "";
  const held = key ? openNotes.get(key) : undefined;
  return { key, owner, note: held && sameNoteOwner(held.owner, owner) ? held : null };
}

/** Open a note on this diff, in place of the one it held. */
export function openNote(key: string, note: OpenNote): void {
  hold(key, note);
  published();
}

/**
 * What an editor that is not the store's own view of the note reports as the
 * reader types. Nothing is published: that editor already shows the text, and
 * the note only has to be here if the editor goes away without an answer.
 */
export function keepDraft(key: string, owner: DiffNoteScope, target: DiffNoteTarget, draft: string): void {
  const held = openNotes.get(key);
  if (held && sameNoteOwner(held.owner, owner) && diffNotePinKey(held.target) === diffNotePinKey(target)) held.draft = draft;
  else hold(key, { owner, target, draft, fresh: false, aside: false });
}

/**
 * Escape: the editor closes without an answer. Words the reader would lose
 * stay and wait under their line, like a note the column or the screen went
 * away under; an editor with nothing new in it has nothing to keep.
 */
export function setNoteAside(key: string): void {
  const held = openNotes.get(key);
  if (held && halfWritten(held)) {
    held.aside = true;
    held.fresh = false;
  } else openNotes.delete(key);
  published();
}

/** A press on the waiting note: back into the editor, with the keyboard. */
export function resumeNote(key: string): void {
  const held = openNotes.get(key);
  if (!held) return;
  held.aside = false;
  held.fresh = true;
  published();
}

/** Saved or cancelled: the diff has no note in progress any more, wherever it is shown. */
export function dropNote(key: string): void {
  openNotes.delete(key);
  published();
}
