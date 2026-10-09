import { handKeyboardToSession } from "../features/session/keyboard-handover";
import { heldKeyboardZone } from "../lib/dom";
import { tryAppRoot } from "./dom-root";

/**
 * F6 and Shift+F6: move the keyboard to the next or the previous column.
 *
 * Beside the list the page is columns (list · session · files and changes).
 * Tab walks through them, but not out of a session in live input: there Tab
 * and Shift+Tab are the program's, like every other key, and a reader without a
 * mouse would be held in the session. F6 is the key desktops and browsers
 * already give to "next pane", so it is the one key kept back from the program,
 * in live input and composed alike, and it works from the other columns too.
 *
 * Arriving in the session hands the keyboard to what the reader types into (the
 * compose field, or the terminal in live input). Arriving in the list or the
 * inspector focuses its current item, else its first control. With no other
 * column on screen F6 steps between the session's input and its header, so the
 * buttons there are still within reach of Tab.
 */
const COLUMNS = [".rail", ".main", ".inspector"] as const;

const TABBABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), "
  + "textarea:not(:disabled):not([readonly]), summary, [tabindex]:not([tabindex='-1'])";

/** The item a column is showing as chosen, where its keyboard walk starts. */
const CURRENT = "[aria-current]:not([aria-current='false']), [aria-selected='true'], [aria-pressed='true']";

function columnsOnScreen(app: HTMLElement): HTMLElement[] {
  return COLUMNS.flatMap((selector) => {
    const column = app.querySelector<HTMLElement>(`:scope > ${selector}`);
    if (!column || column.hidden) return [];
    if (selector === ".rail" && app.classList.contains("rail-hidden")) return [];
    return [column];
  });
}

function tabbable(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(control => control.tabIndex >= 0 && !control.closest("[hidden], [inert]"));
}

function enterColumn(column: HTMLElement): void {
  if (column.matches(".main")) {
    // A complete terminal in composed input takes no focus itself (its own field
    // is switched off): the draft field is what the reader types into there.
    const draft = column.querySelector<HTMLElement>("textarea.full-terminal-compose-input");
    if (draft) {
      draft.focus({ preventScroll: true });
      return;
    }
    handKeyboardToSession();
    if (column.contains(document.activeElement)) return;
  }
  const controls = tabbable(column);
  (controls.find(control => control.matches(CURRENT)) ?? controls[0])?.focus();
}

export function moveKeyboardToColumn(step: 1 | -1): void {
  const app = tryAppRoot();
  if (!app?.classList.contains("desk")) return;
  const columns = columnsOnScreen(app);
  const main = columns.find(column => column.matches(".main"));
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onPage = !active || active === document.body || active === document.documentElement;
  const here = columns.find(column => column.contains(active)) ?? (onPage ? heldKeyboardZone() ?? main : undefined);
  const at = here instanceof HTMLElement ? columns.indexOf(here) : -1;
  if (columns.length > 1 || at < 0) {
    const next = columns[(Math.max(at, 0) + (at < 0 ? 0 : step) + columns.length) % columns.length];
    if (next) enterColumn(next);
    return;
  }
  // One column: between what the reader types into and the first control above it.
  const header = main ? tabbable(main)[0] : undefined;
  if (main && header && (onPage || active?.matches("textarea, input"))) header.focus();
  else if (columns[0]) enterColumn(columns[0]);
}
