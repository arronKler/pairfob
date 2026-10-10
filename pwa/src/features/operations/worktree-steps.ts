/**
 * An action as a step of the dialog that offers it (the Worktree rows of the
 * branches dialog beside the files).
 *
 * A row of that dialog asks for a list or a form. The step opens over the
 * dialog, which stays where it is (`DIALOG_STEP`, overlay/modal.tsx): Escape,
 * Cancel, the step's close control, or on a finger's sheet its bar, the
 * backdrop and the system's back, undo that one step and the reader is back on
 * the row that asked. The dialog is closed only once the step did something.
 *
 * A step tells `closed` how it went away: true when it did what it is for.
 */
export type DialogStep = (closed: (done: boolean) => void) => unknown;

/** Run `step` from a row of the dialog `close` puts away. */
export function runDialogStep(step: DialogStep, close: () => void): void {
  void step(done => { if (done) close(); });
}
