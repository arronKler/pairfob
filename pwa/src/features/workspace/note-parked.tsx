import { PenLine } from "lucide-react";
import { type DiffNoteTarget } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { dropNote, type OpenNote } from "./note-drafts";
import { returnToNoteLine } from "./note-line-focus";
import { diffLineHasNote, diffNoteEditorTitle, diffNotePinKey, openNoteEditorAllowed, saveDiffNote } from "./notes";
import { bumpWorkspaceNotes } from "./store";

/**
 * A half-written note waiting under its line.
 *
 * Both presentations of a diff show it the same way: the workspace screen for
 * any note that is not in its sheet (`note-sheet`), the inspector for one the
 * reader left with Escape (`note-inline`). It is not saved and not lost: the
 * card says so, and offers the three answers an editor would.
 */
export type ParkedNote = {
  note: OpenNote;
  /** Save the words as they stand. */
  save(): void;
  /** Cancel the note, as Cancel in an editor does. */
  discard(): void;
};

/** The waiting note held at `key` (`note-drafts`), with its answers. */
export function parkedNote(key: string, note: OpenNote): ParkedNote {
  return {
    note,
    save() {
      if (!openNoteEditorAllowed(note.target)) return;
      if (!saveDiffNote(note.target, note.draft ?? "", note.owner, diffLineHasNote(note.target))) return;
      // The card leaves with the answer, and the pressed button with it.
      returnToNoteLine(diffNotePinKey(note.target));
      dropNote(key);
      bumpWorkspaceNotes();
    },
    discard() {
      returnToNoteLine(diffNotePinKey(note.target));
      dropNote(key);
    },
  };
}

/**
 * The card under the line. It sits where a saved note's card does and reads as
 * one that is not saved yet: the words, then Cancel and Save where a saved note
 * has Edit and Delete. Pressing the words opens the editor on them.
 */
export function ParkedNoteCard({ parked, onResume }: { parked: ParkedNote; onResume: (target: DiffNoteTarget) => void }) {
  const { target, draft } = parked.note;
  const resume = () => {
    if (openNoteEditorAllowed(target)) onResume(target);
  };
  return <div className="workspace-diff-note is-draft">
    <Button className="diff-note-main diff-note-resume" aria-label={diffNoteEditorTitle(target, diffLineHasNote(target))} onClick={resume}>
      <PenLine className="diff-note-mark" size={16} aria-hidden="true" />
      <span className="diff-note-state">{t("diffNotes.draft")}</span>
      <span className="diff-note-body">{draft}</span>
    </Button>
    <div className="diff-note-actions">
      <Button className="btn btn-small btn-ghost diff-note-action diff-note-discard" onClick={parked.discard}>{t("cancel")}</Button>
      <Button className="btn btn-small btn-ghost diff-note-action diff-note-keep" onClick={parked.save}>{t("diffNotes.save")}</Button>
    </div>
  </div>;
}
