import { hasOpenDialog, heldKeyboardZone, keyboardMoves, KEYBOARD_ZONES } from "../../lib/dom";
import { openPaneId, sessionStore } from "./session-store";

/**
 * Whether the session may pull focus to itself after a paint, a mount or a
 * reconnect.
 *
 * Beside the list and the inspector the session is one column of three, and
 * those columns keep the keyboard while the reader works in them: a commit must
 * not drag the caret out of a diff note, and Ctrl+C on a selected diff line
 * must not end up in the compose field on its way to the PTY. A dialog, menu or
 * panel keeps the keyboard too.
 *
 * Opening a pane is the exception. The press that chose it left focus on its
 * list row, and the session it opened is what the reader means to type into.
 * That handover holds until they press or focus somewhere else, because the
 * complete terminal takes the keyboard only once its renderer and bridge exist,
 * and a touch tablet proves its keyboard only with the first key typed.
 *
 * A key that closes a files surface is the opposite case: focus goes back to
 * the button that opened it, and the session leaves it there for as long.
 */

/** Where the keyboard stood at one moment: the page has not been pressed or focused elsewhere while it still reads the same. */
type Standing = { active: Element | null; held: Element | null; moves: number };

function standing(): Standing {
  return { active: document.activeElement, held: heldKeyboardZone(), moves: keyboardMoves() };
}

function stands(mark: Standing | null): mark is Standing {
  return mark !== null && mark.moves === keyboardMoves()
    && mark.active === document.activeElement && mark.held === heldKeyboardZone();
}

let watching = false;
let seenPane = "";
/** Where focus stood when the open pane last changed; null once the reader moved on. */
let arrival: Standing | null = null;
/** A control that was handed the keyboard instead of the session, or the moves count while that is still being settled. */
let withheld: Standing | number | null = null;

function noteOpenPane(): void {
  const paneId = openPaneId();
  if (paneId === seenPane) return;
  seenPane = paneId;
  arrival = paneId ? standing() : null;
}

/**
 * See a pane arrive when it does. Asked only once a session wants focus, the
 * arrival would be read then: after whatever the reader pressed in between. So
 * the page watches from boot, and a pane that was already open when the watch
 * began was not seen arriving: where focus stands now says nothing about it.
 */
export function watchSessionArrivals(): void {
  if (watching) {
    noteOpenPane();
    return;
  }
  watching = true;
  seenPane = openPaneId();
  sessionStore.subscribe(noteOpenPane);
}

/**
 * The reader chose the session that is already open, by its own row in the
 * list. No pane changed to mark an arrival, but it is the same handover: the
 * press left focus on the row, and the session is what they mean to type into.
 */
export function noteSessionChosen(): void {
  watchSessionArrivals();
  arrival = standing();
}

/**
 * The press that chose the open session is still the last thing the reader
 * did, and `target` is where it left focus: the session's row in the list, or
 * the page in a browser that does not focus a pressed button. Nothing moved
 * focus into the session, because no keyboard was known then (a touch tablet)
 * or the session was not ready for it; a key typed there is still meant for it.
 */
export function sessionChosenAt(target: EventTarget | null): boolean {
  watchSessionArrivals();
  if (!stands(arrival) || hasOpenDialog()) return false;
  return target === arrival.active || target === document.body || target === document.documentElement;
}

/**
 * A key is closing the surface that has the keyboard, and focus is on its way
 * to `control`. The session stays out of it from now, and once the returned
 * function is given the control that took focus, for as long as focus rests
 * there untouched. Given null, nothing is withheld.
 */
export function withholdKeyboardFromSession(): (control: Element | null) => void {
  const pending = keyboardMoves();
  withheld = pending;
  return (control) => {
    if (withheld !== pending) return;
    withheld = control && control === document.activeElement ? standing() : null;
  };
}

function keyboardWithheld(): boolean {
  if (withheld === null) return false;
  // Still settling: it lapses by itself if the reader presses on before it does.
  if (typeof withheld === "number" ? withheld === keyboardMoves() : stands(withheld)) return true;
  withheld = null;
  return false;
}

/**
 * The list or the inspector holds the keyboard: focus is inside one, or the
 * reader last pressed something there that cannot take focus itself.
 */
export function keyboardHeldBeside(): boolean {
  return heldKeyboardZone() !== null || Boolean(document.activeElement?.closest(KEYBOARD_ZONES));
}

export function sessionMayTakeFocus(): boolean {
  watchSessionArrivals();
  if (hasOpenDialog() || keyboardWithheld()) return false;
  if (arrival) {
    if (stands(arrival)) return true;
    arrival = null;
  }
  return !keyboardHeldBeside();
}
