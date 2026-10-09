/**
 * What the files surfaces opened over the page, and its end when they leave.
 *
 * A file's menu, the path sheet, the question before a delete and the rename
 * field are all about a row of the list. They are drawn in the top layer, so
 * they outlive the surface they were opened from: the column parked by a
 * window dragged narrow or a tablet turned upright, the screen left for the
 * session by something other than the reader. What is left then floats over
 * the session and asks about a file whose list is no longer shown. Its answer
 * would do nothing (every action checks that its list is still presented), but
 * nothing on the page says so.
 *
 * So the surface that goes away takes them with it: each is closed as Escape
 * would close it, unanswered. A menu anchored to its row closes on its own once
 * the row is gone (`popover-frame`); this also covers what has no anchor, the
 * bottom sheet a finger gets and the dialogs in the middle of the page.
 *
 * A line note is not one of these. Its editor belongs to the diff and unmounts
 * with it, and what was typed is kept for when the diff is shown again
 * (`note-drafts`).
 */

/** Marks a dialog a files surface opened. */
const OWNED = "data-files-dialog";

const openDialogs = (): HTMLDialogElement[] => [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];

/**
 * Run `open`, which draws a dialog for a files surface, and mark what it drew.
 * The shared dialogs are on the page by the time the call that asks for them
 * returns, and hand out no handle to close them by.
 */
export function ownFilesDialog<T>(open: () => T): T {
  const before = new Set(openDialogs());
  const result = open();
  for (const dialog of openDialogs()) if (!before.has(dialog)) dialog.setAttribute(OWNED, "");
  return result;
}

/** The list these were opened from is no longer shown: put each away without an answer, the top one first. */
export function dismissFilesDialogs(): void {
  for (const dialog of openDialogs().reverse()) if (dialog.hasAttribute(OWNED)) dialog.close("cancel");
}
