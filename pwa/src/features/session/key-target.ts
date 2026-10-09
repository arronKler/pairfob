import { KEYBOARD_ZONES } from "../../lib/dom";
import { sessionChosenAt } from "./focus";
import { isPlainPress } from "../../shared/ui/dom/plain-press";

/**
 * Whose key it is, by where it was pressed.
 *
 * A key is the session's only while the session column holds the keyboard:
 * focus is inside it (the desk main column, or the whole app on a phone), or
 * focus has dropped to <body> and no other region was the last one used. The
 * list rail, the inspector, and any menu, panel, dialog or palette keep their
 * keys to themselves, so Ctrl+C over a diff copies instead of interrupting the
 * agent beside it. The guided session, a conversation and the complete terminal
 * all route by these rules, so one keyboard means the same thing in each.
 */

/** Top-layer surfaces that own the keyboard while focus is inside them. */
const OVERLAYS = "dialog, [popover], [role='dialog'], [role='menu'], [role='listbox'], .command-palette";

/** Regions that own the keyboard while focus is inside them. */
const CLAIMED = `${KEYBOARD_ZONES}, ${OVERLAYS}`;

/** Fields: every key typed at one is its own. */
const FIELD = "input, textarea, select, [contenteditable='true']";

/** Controls a press activates: Enter and Space are theirs, Tab moves on from them, and no other key is. */
const PRESSED = "button, a, summary, [role='button']";

/**
 * Controls that are steered with more keys than the two that press them: the
 * arrows walk a tab strip, a radio group or a menu, and step a slider. Every
 * key typed at one stays its own.
 */
const STEERED = "[role='tab'], [role='radio'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], "
  + "[role='option'], [role='slider'], [role='spinbutton']";

function inSessionColumn(target: HTMLElement): boolean {
  const app = target.closest("#app");
  if (!app) return false;
  return !app.classList.contains("desk") || target.closest(".main") !== null;
}

/**
 * Whether a keydown on `target` belongs to the session. `held` is the rail or
 * inspector the reader last pressed or focused in: a click on a diff line
 * leaves focus on <body>, and that must not hand its keys to the session.
 */
export function sessionHoldsKeys(target: EventTarget | null, held: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target === document.body || target === document.documentElement) return !held?.isConnected;
  if (target.closest(FIELD) || target.closest(PRESSED) || target.closest(STEERED) || target.closest(CLAIMED)) return false;
  return inSessionColumn(target);
}

/**
 * Focus resting on a plain button, a link or a step heading in the session
 * column. A click leaves it there: the heading that was opened, the copy
 * button, the `···` button its panel handed focus back to. The control has a
 * use for three keys only (`controlKeepsKey`), so on a hardware keyboard the
 * session routes every other one as if the page held focus: a reader who closed
 * a panel does not have to click the screen before Esc or Ctrl+C work again.
 */
export function sessionControlHasFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target.closest(FIELD) || target.closest(CLAIMED)) return false;
  return target.closest(PRESSED) !== null && target.closest(STEERED) === null && inSessionColumn(target);
}

/**
 * Focus resting on the header's files button while the column it opened is
 * showing: the reader's last act was opening that column, and the button still
 * reads as pressed. Esc there closes the column, as Esc closes whatever was
 * opened last, in every session view; with the column closed the button is a
 * plain one again and Esc is the session's. Focus anywhere else in the session
 * does not get this: beside an open column, Esc typed at a session stays the
 * session's.
 */
export function inspectorToggleHasFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const toggle = target.closest(".chrome-actions .icon-workspace[aria-pressed='true']");
  return toggle !== null && toggle.closest("#app.desk .main") !== null;
}

/**
 * What a focused button or link does with the keyboard itself: plain Enter and
 * Space press it, Tab and Shift+Tab move on. Enter with a modifier is not a
 * press (`shared/ui/dom/plain-press`): Shift+Enter is the program's line feed
 * wherever focus rests in the session, so it is routed like any other key.
 */
export function controlKeepsKey(event: KeyboardEvent): boolean {
  return event.key === "Tab" || isPlainPress(event);
}

/**
 * A key pressed where the press that chose the session left focus: its row in
 * the list, or the page. Opening a session is choosing the session column, so
 * the key is the session's as if the page held focus, although the list was
 * the last column pressed. The row still answers its own Enter and Space and
 * lets Tab move on, and a field that opened the session (a search box) keeps
 * what is typed into it.
 */
export function sessionChosenTakes(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!sessionChosenAt(target)) return false;
  if (!(target instanceof HTMLElement) || target === document.body || target === document.documentElement) return true;
  if (target.closest(FIELD) || target.closest(OVERLAYS)) return false;
  return !(target.closest(PRESSED) && controlKeepsKey(event));
}
