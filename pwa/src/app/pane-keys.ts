import { bindKeyboardZones, hasBlockingDialog, hasOpenDialog, heldKeyboardZone } from "../lib/dom";
import { openCommandPalette } from "../features/command-palette";
import { phase as currentPhase } from "../features/connection/connection-store";
import { typeIntoAgentCompose } from "../features/session/chat/agent-compose";
import { readAgentStream } from "../features/session/chat/reading-keys";
import { watchSessionArrivals } from "../features/session/focus";
import { handlePaneKey } from "../features/session/guided/compose";
import { controlKeepsKey, inspectorToggleHasFocus, sessionChosenTakes, sessionControlHasFocus, sessionHoldsKeys }
  from "../features/session/key-target";
import { isAgentChat, isFullTerminal, termSelect } from "../features/session/session-store";
import { closeWorkspaceInspector } from "../features/workspace/inspector";
import { declineModifiedPress } from "../shared/ui/dom/plain-press";
import { dismissPopovers } from "../shared/ui/overlay/popover";
import { moveKeyboardToColumn } from "./column-keys";
import { bindInputMode, hardwareKeyboard, macPlatform } from "./input-mode";
import { currentScreen } from "./navigation-store";
import { isDesk } from "./viewport";

/**
 * Page-level keys: which keydown reaches the open session, the two global
 * shortcuts (search and jump, and F6 between the columns), and Esc on the files
 * button that has its column open.
 *
 * A key is forwarded to the session only while the session column holds the
 * keyboard (`features/session/key-target`). The complete terminal binds its own
 * keys by the same rule (`full-terminal-desk-keys`).
 */
export { sessionControlHasFocus, sessionHoldsKeys };

/**
 * ⌘K, on Apple platforms only: elsewhere Ctrl+K is "kill line" in the terminal
 * this page drives, and one key should mean one thing everywhere.
 */
function isPaletteChord(event: KeyboardEvent): boolean {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat
    && event.key.toLowerCase() === "k" && macPlatform();
}

export function bindPaneKeys(signal: AbortSignal, openPalette: () => void = openCommandPalette): void {
  signal.addEventListener("abort", bindKeyboardZones(document), { once: true });
  // Bound first: a key that proves a hardware keyboard is read as one by every
  // listener after it.
  signal.addEventListener("abort", bindInputMode(document), { once: true });
  // From boot: a session opened by a tap is remembered as chosen before any key proves a keyboard.
  watchSessionArrivals();

  // Capture: the shortcut works wherever focus is, including inside a terminal
  // or a field that consumes its own keys.
  document.addEventListener("keydown", (event) => {
    if (currentPhase() !== "live" || !isPaletteChord(event)) return;
    // A dialog that must be answered first keeps the keyboard; a menu or panel steps aside.
    if (hasBlockingDialog()) return;
    event.preventDefault();
    event.stopPropagation();
    if (!dismissPopovers(openPalette)) openPalette();
  }, { capture: true, signal });

  // Capture, like the palette chord: live input sends every other key to the
  // program, so this one has to be taken before a field or the terminal sees it.
  document.addEventListener("keydown", (event) => {
    if (currentPhase() !== "live" || event.key !== "F6" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!isDesk() || !hardwareKeyboard() || hasOpenDialog()) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) moveKeyboardToColumn(event.shiftKey ? -1 : 1);
  }, { capture: true, signal });

  // Capture, and bound before any session view binds its own keys: a focused
  // button of the session column otherwise routes Esc to the running program,
  // which interrupts an agent at work. The press that closes the column is not
  // also the session's while it is held.
  let closingEscape = false;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const closes = !event.repeat && currentPhase() === "live" && currentScreen() === "pane" && !hasOpenDialog()
      && inspectorToggleHasFocus(event.target);
    if (!closes && !(event.repeat && closingEscape)) return;
    event.preventDefault();
    // Immediate: the complete terminal listens on the document too.
    event.stopImmediatePropagation();
    if (!closes) return;
    closingEscape = true;
    closeWorkspaceInspector();
  }, { capture: true, signal });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") closingEscape = false;
  }, { capture: true, signal });

  document.addEventListener("keydown", (event) => {
    if (currentPhase() !== "live" || currentScreen() !== "pane" || termSelect() || isFullTerminal()) return;
    if (event.defaultPrevented) return;
    // An open dialog (modal, menu or panel): never forward typing keys to the
    // pane. This is checked before the target guard because focus can drop to
    // <body> (the Insert All/focused button being disabled), so an ESC or
    // printable key must not leak into the PTY — native Escape keeps closing
    // the topmost one.
    if (hasOpenDialog()) return;
    // Beside the list, the press that opened this session still stands: its keys
    // are the session's from the row it left focus on, once a keyboard is known
    // to be typing. A phone has no list beside the session to leave focus on.
    const holds = sessionHoldsKeys(event.target, heldKeyboardZone())
      || (isDesk() && hardwareKeyboard() && sessionChosenTakes(event));
    if (!holds) {
      // Focus on a button or a link: it keeps the keys it has a use for, and
      // the session routes the rest as if the page held focus. Without a
      // hardware keyboard it keeps them all, as a phone always has.
      if (!hardwareKeyboard() || !sessionControlHasFocus(event.target) || controlKeepsKey(event)) return;
    }
    // Routed away from a focused button or row, Enter with a modifier must not press it as well.
    declineModifiedPress(event);
    // A conversation has no PTY to type into: a reading key scrolls it and a
    // character goes to its draft.
    if (isAgentChat()) {
      if (!readAgentStream(event)) typeIntoAgentCompose(event);
    } else {
      handlePaneKey(event, false);
    }
  }, { signal });
}
