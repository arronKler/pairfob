import type { MouseEvent } from "react";
import { guardBackTap } from "../../shared/ui/dom/back-tap";

/**
 * The files surfaces' own ways back: the inspector's file chip and its Close,
 * the directory's Up and the folders above it, the receipt's return to the
 * session.
 *
 * Each swaps what is under the pointer as it is pressed, so the second half of
 * a doubled press lands on what came up there: the repository title, which
 * opens the branch sheet; the session's `···`; Up again, one folder too far; a
 * key of the session's key row, which goes to the running program. They arm
 * the guard every `BackButton` arms (`shared/ui/dom/back-tap`); the screen's
 * header is one of those already. The guard keeps the doubled press itself from
 * what came up, so a control that acts as it is pressed (a key of the key row)
 * is covered like one that acts on its click.
 *
 * Call it from the control's click handler, before going back. A key, or a
 * scripted click, is nobody's doubled press and goes straight through.
 */
export function guardBackPress(event: MouseEvent<HTMLElement>): void {
  if (event.detail !== 0) guardBackTap(event.currentTarget.ownerDocument, { x: event.clientX, y: event.clientY });
}
