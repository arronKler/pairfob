import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { DIFF_NOTE_BODY_LIMIT, type DiffNoteTarget } from "../../lib/diff-notes";
import { t } from "../../lib/i18n";
import { Button } from "../../shared/ui/primitives";
import { dropNote, halfWritten, openNote, resumeNote, setNoteAside, unsaved, useHeldNote, type OpenNote } from "./note-drafts";
import { parkedNote, type ParkedNote } from "./note-parked";
import { diffNoteEditorTitle, diffNotePinKey, submitOnModEnter, useNoteEditor } from "./notes";
import { bumpWorkspaceNotes } from "./store";

/**
 * A note written under its diff line in the inspector.
 *
 * Beside the session a note is edited in place: the form opens under its line,
 * inside the column, so the keyboard never leaves the column for a dialog and
 * falls back to the session when that dialog closes. The workspace screen keeps
 * its text-edit sheet (`note-sheet`).
 *
 * The note itself is held in `note-drafts`, not in the column's component
 * state: the column comes and goes with the window's width and the files
 * button, and a half-written note has to be there when the reader returns to
 * its line, here or on the workspace screen.
 *
 * Escape leaves the form the way those do, without an answer: the words stay
 * and wait under the line as the card the screen shows (`note-parked`). Only
 * Cancel throws them away.
 *
 * The keyboard goes with the note as well. A column that leaves while the
 * reader is typing in the form (the tablet turned upright, the window dragged
 * narrow) takes the field away under the caret, and the session next door
 * picks the keys up. When the column brings the form back the field takes the
 * keyboard again, unless the reader has pressed or typed somewhere in between:
 * then they have moved on, and the note waits as any other does.
 */

/** Focus the mounted editor's field; null while no editor is mounted. */
let focusOpenNote: (() => void) | null = null;

/** The note whose form left the page with the keyboard in it, until the reader presses or types elsewhere. */
let leftWithKeyboard: OpenNote | null = null;
let stopWatchingReader: (() => void) | null = null;

/** Held on their own these type nothing and move nothing: a window is often resized with them down. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"]);

function forgetKeyboard(): void {
  leftWithKeyboard = null;
  stopWatchingReader?.();
  stopWatchingReader = null;
}

/** The form is leaving with the keyboard in it: `note` has it back if the reader does nothing else first. */
function keepKeyboardFor(note: OpenNote): void {
  forgetKeyboard();
  leftWithKeyboard = note;
  const moved = (event: Event): void => {
    if (event.type === "keydown" && MODIFIERS.has((event as globalThis.KeyboardEvent).key)) return;
    forgetKeyboard();
  };
  document.addEventListener("pointerdown", moved, true);
  document.addEventListener("keydown", moved, true);
  stopWatchingReader = () => {
    document.removeEventListener("pointerdown", moved, true);
    document.removeEventListener("keydown", moved, true);
  };
}

/** `note`'s form is back on the page: whether the keyboard it left with is still its own. */
function keyboardReturnsTo(note: OpenNote): boolean {
  const returns = leftWithKeyboard === note;
  if (returns) forgetKeyboard();
  return returns;
}

export type InlineNote = {
  /** The note open in this diff, if any. */
  note: OpenNote | null;
  /** The note left with Escape, waiting under its line; null while the form shows it, or there is none. */
  parked: ParkedNote | null;
  open(target: DiffNoteTarget): void;
  close(changed: boolean): void;
  /** Escape: the form closes and what it held waits under its line. */
  setAside(): void;
};

/** The inline editor of one diff (`diffKey` is its file and layer). */
export function useInlineNote(diffKey: string): InlineNote {
  const { key, owner, note: held } = useHeldNote(diffKey);
  const waiting = held?.aside && halfWritten(held) ? held : null;
  const note = held && !held.aside ? held : null;
  return {
    note,
    parked: waiting ? parkedNote(key, waiting) : null,
    open(target) {
      if (!owner) return;
      // The same line again, or another line while this one is half written:
      // a press never drops what the reader is typing. They save or cancel
      // it first, as the sheet's backdrop makes them do. A note that waits
      // under its line is half written too, and any line leads back into it.
      if (waiting) {
        resumeNote(key);
        return;
      }
      if (note && (diffNotePinKey(note.target) === diffNotePinKey(target) || unsaved(note))) {
        focusOpenNote?.();
        return;
      }
      openNote(key, { owner, target, draft: null, fresh: true, aside: false });
    },
    close(changed) {
      dropNote(key);
      if (changed) bumpWorkspaceNotes();
    },
    setAside: () => setNoteAside(key),
  };
}

/**
 * The form under the line: the body, then cancel and save where the pointer
 * already is. Escape sets the note aside and Ctrl/⌘+Enter saves, as in the
 * sheet. The line itself stays visible above, so nothing here quotes it.
 */
export function InlineNoteEditor({ note, onClose, onSetAside }: {
  note: OpenNote; onClose: (changed: boolean) => void; onSetAside: () => void;
}) {
  const target = note.target;
  const { existing, validationId, invalid, draft, unchanged, textareaRef, submit, remove, field } =
    useNoteEditor(target, onClose, note.draft ?? undefined);
  const form = useRef<HTMLFormElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Once the field has had the keyboard its caret is where the reader left
    // it. Until then it is at the start of whatever the field was mounted with:
    // a note the column brought back after a rotation would take the next
    // words in front of the ones already written.
    let placed = false;
    const notePlaced = () => { placed = true; };
    textarea.addEventListener("focus", notePlaced);
    const focus = () => {
      const resumed = !placed;
      textarea.focus({ preventScroll: true });
      if (resumed) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      // The form sits under the line it belongs to, which may not be the line just pressed.
      form.current?.scrollIntoView?.({ block: "nearest" });
    };
    focusOpenNote = focus;
    // A note the column brought back with it waits where it is: only the press
    // that opens one moves the keyboard into it, or the column returning with
    // the note the reader was typing in when it left.
    const returning = keyboardReturnsTo(note);
    if (note.fresh || returning) {
      note.fresh = false;
      focus();
    }
    return () => {
      // Still attached here, and still focused if the form is leaving under the reader.
      if (!note.aside && form.current?.contains(document.activeElement)) keepKeyboardFor(note);
      textarea.removeEventListener("focus", notePlaced);
      if (focusOpenNote === focus) focusOpenNote = null;
    };
  }, []);

  const setAsideOnEscape = (event: KeyboardEvent<HTMLFormElement>) => {
    // Escape during composition belongs to the input method.
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    // The key is the form's whatever it holds: it never goes on to the session.
    event.preventDefault();
    event.stopPropagation();
    onSetAside();
  };

  return <form ref={form} className="diff-note-inline" aria-label={diffNoteEditorTitle(target, Boolean(existing))} noValidate
    onSubmit={submit} onKeyDown={setAsideOnEscape}>
    <textarea {...field} rows={3} aria-label={t("diffNotes.field")} onKeyDown={submitOnModEnter}
      onInput={(event) => {
        field.onInput(event);
        note.draft = event.currentTarget.value;
      }} />
    <p className="notice notice-error" id={validationId} role="alert" hidden={!invalid}>
      {invalid ? t("diffNotes.needBody") : ""}
    </p>
    <div className="diff-note-inline-foot">
      <span className="diff-note-count">{`${draft.length} / ${DIFF_NOTE_BODY_LIMIT}`}</span>
      {remove && <Button className="diff-note-remove" onClick={remove}>{t("diffNotes.deleteNote")}</Button>}
      <Button className="btn btn-small btn-ghost diff-note-inline-cancel" onClick={() => onClose(false)}>{t("cancel")}</Button>
      <button type="submit" className="btn btn-small btn-primary diff-note-inline-save" disabled={unchanged}>{t("text.save")}</button>
    </div>
  </form>;
}
