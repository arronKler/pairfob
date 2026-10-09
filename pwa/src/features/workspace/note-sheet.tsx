import { useState } from "react";
import { type DiffNoteScope, type DiffNoteTarget } from "../../lib/diff-notes";
import { dropNote, halfWritten, keepDraft, setNoteAside, useHeldNote } from "./note-drafts";
import { returnToNoteLine } from "./note-line-focus";
import { parkedNote, type ParkedNote } from "./note-parked";
import { diffNotePinKey } from "./notes";
import { bumpWorkspaceNotes } from "./store";

/**
 * A note written on the workspace screen.
 *
 * The screen edits a note in its text-edit sheet (`DiffNoteEditor`), one press
 * at a time: nothing opens it but the reader. So a note they left half written
 * elsewhere (in the inspector before the window narrowed, or in a sheet the
 * screen went away under or they left with Escape) does not take the screen
 * over when its diff is shown again. It waits under its line as a card that
 * says it is not saved yet (`note-parked`), and one press on it opens the sheet
 * with their words. They can also read the rest of the diff, step to another
 * file or go back to the session, and the note goes with them (`note-drafts`).
 *
 * The sheet opened from that card closes over a card that is gone or drawn
 * anew, so whatever closes it hands the keyboard to the note's line
 * (`note-line-focus`); opened from the line itself, the line has it already.
 */

export type SheetNote = {
  /** What the sheet is open on; null while it is closed. */
  editing: { target: DiffNoteTarget; startWith?: string } | null;
  /** Null while the sheet shows the note, or there is none. */
  parked: ParkedNote | null;
  open(target: DiffNoteTarget): void;
  /** What the reader types in the sheet. */
  draft(text: string): void;
  close(changed: boolean): void;
  /** Escape: the sheet closes and what it held waits under its line. */
  setAside(): void;
};

type Sheet = { key: string; owner: DiffNoteScope | null; target: DiffNoteTarget; startWith?: string };

/** The sheet of the workspace screen, for the diff it shows (`diffKey` is its file and layer). */
export function useSheetNote(diffKey: string): SheetNote {
  const { key, owner, note } = useHeldNote(diffKey);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const waiting = note && halfWritten(note) ? note : null;
  const shown = Boolean(sheet && waiting && sheet.key === key && diffNotePinKey(sheet.target) === diffNotePinKey(waiting.target));
  return {
    editing: sheet,
    parked: waiting && !shown ? parkedNote(key, waiting) : null,
    open(target) {
      // Another line while one is half written: a press never drops what the
      // reader typed, here as in the inspector. The sheet opens on that note,
      // and they save or cancel it first.
      if (waiting) {
        // Open again: no longer the note they left with Escape.
        waiting.aside = false;
        setSheet({ key, owner, target: waiting.target, startWith: waiting.draft ?? undefined });
      } else setSheet({ key, owner, target });
    },
    draft(text) {
      if (sheet?.owner) keepDraft(sheet.key, sheet.owner, sheet.target, text);
    },
    close(changed) {
      if (sheet) returnToNoteLine(diffNotePinKey(sheet.target));
      setSheet(null);
      if (sheet) dropNote(sheet.key);
      if (changed) bumpWorkspaceNotes();
    },
    setAside() {
      if (sheet) returnToNoteLine(diffNotePinKey(sheet.target));
      setSheet(null);
      if (sheet) setNoteAside(sheet.key);
    },
  };
}
