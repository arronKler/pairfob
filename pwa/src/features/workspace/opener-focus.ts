import { isDesk, isRoomy } from "../../app/viewport";
import { overlayOrigin } from "../../shared/ui/overlay/origin";
import { withholdKeyboardFromSession } from "../session/focus";
import { inspectorOpen } from "./inspector-store";

/**
 * Where the keyboard goes when a files surface opens or closes under it.
 *
 * The inspector and the files screen both open from the session header's files
 * button. Closed with a key pressed inside one (Enter on Close, on Back), the
 * control that held focus leaves with the surface, focus falls to <body>, and
 * the next Tab starts again from the top of the page. So focus goes back to the
 * button that opened the surface, as it stays there when that button itself
 * closes the column. The session is told first: one that takes the keyboard as
 * it arrives (the guided field on its paint, the complete terminal once its
 * bridge is up) would take it from the button, and Tab typed there is the
 * running program's.
 *
 * The screen left for a session that has the column beside it (it was opened
 * from the column's "open as a page") goes back there instead, to that control:
 * the reader is still in the files, and the next Esc closes what the column
 * shows, then the column, as it did before they opened the page. On the files
 * button it would be out of the column's reach, and the column would stay. For
 * the same reason Esc counts there with nothing focused, the way the screen
 * itself counts it (`escape`): a mouse opened the page and a key left it.
 *
 * Opened with a key (Enter on the inspector's "open as a page", or on the files
 * button where the window has no room for the column), the screen replaces what
 * held focus in the same way, and its first control takes it: Back.
 *
 * The column opened with a key replaces nothing, and the button keeps focus.
 * But the column is out of reach from there: Tab goes on through the session,
 * whose field keeps Tab for the running program. So the column takes focus as
 * the screen does, on its selected tab, and Esc or its Close hands it back.
 *
 * Only for a key, and only beside the list. A mouse or a finger leaves focus on
 * <body>, which is where the session picks typing up (`app/pane-keys`); a
 * focused button would take the next Enter or Space for itself. And only when
 * focus is still lost once the change has settled: nothing here takes focus
 * from whatever took it meanwhile.
 */

/** The session header's files button, in the column beside the list. */
const OPENER = "#app .main .chrome-actions .icon-workspace";

/** The files screen's first control. */
const SCREEN_BACK = "#app .workspace-shell .back";

/** The column beside the session. */
const COLUMN = "#app .workspace-inspector";

/** The column's "open as a page": where the screen was opened from while the column is there. */
const COLUMN_EXPAND = `${COLUMN} .inspector-expand`;

/** The files screen. */
const SCREEN = ".workspace-shell";

/** The session the screen is left for has the column beside it. */
const columnReturns = (): boolean => inspectorOpen() && isRoomy();

/**
 * A key was the reader's last input and focus is inside `surface` (anywhere on
 * the page when none is named). `orNowhere` counts <body> as inside, for a
 * surface that has the page to itself.
 */
function keyPressedIn(surface?: string, orNowhere = false): boolean {
  const active = document.activeElement;
  if (overlayOrigin()?.input !== "key" || !isDesk()) return false;
  if (!(active instanceof HTMLElement) || active === document.body) return orNowhere && active === document.body;
  return surface === undefined || active.closest(surface) !== null;
}

/** Focus the first of `selectors` on the page once the change has settled, if focus was lost with what it replaced. */
function focusWhenLost(selectors: string[], done?: (focused: HTMLElement | null) => void): void {
  // Behind the commit's own focus work, as `useInspectorFocus` waits for a closing dialog's.
  window.setTimeout(() => {
    const now = document.activeElement;
    const lost = !now || now === document.body || !now.isConnected;
    let target: HTMLElement | null = null;
    if (lost && !document.querySelector("dialog[open]")) {
      for (const selector of selectors) {
        target = document.querySelector<HTMLElement>(selector);
        if (target) break;
      }
    }
    target?.focus({ preventScroll: true });
    done?.(target);
  }, 0);
}

/**
 * Call before closing `surface`; call what it returns once the close is
 * committed.
 */
export function focusLeaving(surface: string): () => void {
  const toColumn = surface === SCREEN && columnReturns();
  if (!keyPressedIn(surface, toColumn)) return () => undefined;
  const settle = withholdKeyboardFromSession();
  return () => focusWhenLost(toColumn ? [COLUMN_EXPAND, OPENER] : [OPENER], settle);
}

/**
 * Call before the files screen replaces the session; call what it returns once
 * the screen is committed.
 */
export function focusEnteringScreen(): () => void {
  if (!keyPressedIn()) return () => undefined;
  return () => focusWhenLost([SCREEN_BACK]);
}

/**
 * Call before the column opens beside the session; call what it returns once
 * it is committed. Its tabs arrive with the first read, so until then the
 * column itself holds the keyboard, and Tab goes on into it.
 */
export function focusEnteringColumn(): () => void {
  if (!keyPressedIn()) return () => undefined;
  const opener = document.activeElement;
  return () => {
    window.setTimeout(() => {
      // The reader has moved on, or a dialog has the keyboard: nothing here takes it from them.
      if (document.activeElement !== opener || document.querySelector("dialog[open]")) return;
      const column = document.querySelector<HTMLElement>(COLUMN);
      (column?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']") ?? column)?.focus({ preventScroll: true });
    }, 0);
  };
}
