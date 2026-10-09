import { hardwareKeyboard, macPlatform } from "../../../app/input-mode";
import { isDesk } from "../../../app/viewport";
import { hasOpenDialog } from "../../../lib/dom";
import { fieldKeepsControlChord } from "../compose-keys";
import { composeDraft, composeIME, composeLive } from "../compose-store";
import { keyboardHeldBeside, sessionMayTakeFocus } from "../focus";
import { controlKeepsKey, sessionChosenTakes, sessionControlHasFocus } from "../key-target";
import { requestFullTerminalPadEnter, typeIntoFullTerminalCompose } from "./full-terminal-compose";
import { replayKeyOnTerminal } from "./full-terminal-key-replay";

export type FullTerminalDeskKeys = {
  /** Page the session, as PageUp / PageDown do in the guided one. */
  page: (direction: "up" | "down") => void;
  /** Send a key to the terminal by its pad name ("esc", "left", "ctrl+c"), as the key row does. */
  send: (key: string) => void;
  /** Give the live terminal the keyboard back, as pressing its own live field does. */
  focus: () => void;
  /** Copy what is selected in the terminal; false when nothing is. */
  copySelection?: () => boolean;
};

/** The keys that go to the terminal as themselves, by their pad names. */
const TERMINAL_KEYS: Record<string, string> = {
  Escape: "esc",
  Tab: "tab",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Keys that are held, not typed: pressing one alone says nothing about where typing should go. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "AltGraph", "NumLock", "ScrollLock"]);

/**
 * Where a key was pressed: the compose field, xterm, the page (focus on <body>
 * with no other column holding the keyboard, or still on the list row that
 * opened this session), or a button of the session column.
 */
type Origin = "field" | "terminal" | "page" | "control";

/**
 * Keys for a complete terminal typed on a hardware keyboard beside the list,
 * wherever in the session column xterm does not already have them.
 *
 * In 组字 the terminal takes no keys itself: xterm's field is switched off, and
 * the session opens with focus on it or on the page. The keys follow the guided
 * session's rule (`handlePaneKey`), so one keyboard means the same thing in both:
 *
 * - pressed there, a printable key starts the draft and moves the caret into
 *   the compose field, Enter sends, and Esc, the arrows and Ctrl with a letter
 *   go to the running program;
 * - from the field, typing and Enter are the field's own, while Esc and Ctrl
 *   with a letter still go to the program, and so do Backspace, the arrows and
 *   Tab once there is no draft for them to edit or complete. Ctrl+C on text
 *   selected in the field copies it;
 * - PageUp / PageDown page the session from either.
 *
 * Tab pressed outside the field stays the way a keyboard reaches the header and
 * the dock, and Shift+Tab always backs out; from the field, Tab goes to the
 * program only while the draft is empty (a prompt waiting for a completion),
 * and with words in the draft it leaves the field like any other. Text dragged
 * out of the terminal is xterm's own selection: off macOS Ctrl+C copies it
 * instead of interrupting, here and in 实时 (`full-terminal-copy`). Command and
 * Alt chords are the browser's, and so is Ctrl+Shift with a letter, which no
 * terminal sends.
 *
 * A plain button of the session column that a click left focused (the files
 * button, `···` after its panel closed, 按键) answers its own Enter and Space
 * and lets Tab move on. Every other key is routed as if the page held focus, in
 * 组字 and in 实时, so nothing has to be clicked before Esc or Ctrl+C work again.
 *
 * Live input belongs to xterm while xterm has focus, and one key is taken from
 * it: Shift+Enter is a line break (a line feed, which agent prompts read as
 * "new line, do not send"), as it is in the guided session and in a draft.
 * Focus drops to the page when the reader presses something that cannot hold
 * it, or closes the inspector with the mouse: a key pressed there is still the
 * terminal's (the dock says so), so xterm gets focus back and the press with
 * it, replayed on xterm so that Home, F5, Tab or Shift+↑ reach the program
 * spelled as xterm spells them (`full-terminal-key-replay`). No press is
 * dropped. A Command chord stays the browser's, and finds the terminal focused
 * by the time it acts, so a paste lands there; only a modifier held on its own
 * is left where it was pressed. F6 never gets here: it moves the keyboard to
 * the next column (`app/column-keys`), the way out of a terminal that keeps Tab.
 *
 * A phone or a touch tablet without a keyboard keeps its own rules: nothing
 * here runs for them.
 *
 * Capture, so a key meant for the draft or the program never reaches xterm on
 * its way.
 */
export function bindFullTerminalDeskKeys(pad: HTMLElement, keys: FullTerminalDeskKeys): () => void {
  const from = (event: KeyboardEvent): Origin | null => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return null;
    if (target.classList.contains("full-terminal-compose-input")) return pad.contains(target) ? "field" : null;
    // The list or the inspector keeps keys pressed over it, focused or not, until this session is chosen from it.
    if (target === document.body || target === document.documentElement) {
      return keyboardHeldBeside() && !sessionChosenTakes(event) ? null : "page";
    }
    const host = target.closest(".full-terminal-host");
    if (host?.parentElement === pad.parentElement && !target.closest("button, a")) return "terminal";
    if (sessionChosenTakes(event)) return "page";
    // A button over the terminal (retry, the scroll rail) is one of these too.
    return sessionControlHasFocus(target) ? "control" : null;
  };

  /** A key pressed on the page while xterm should have had it: hand focus back, and the press with it. */
  const sendLive = (event: KeyboardEvent, take: () => void): void => {
    if (MODIFIER_KEYS.has(event.key)) return;
    keys.focus();
    // The browser's own (paste, copy, the app's ⌘K): left to it, with the terminal focused for it to act on.
    if (event.metaKey) return;
    const typed = event.key.length === 1 && !event.ctrlKey;
    // A character goes the way the key row sends one, armed modifiers included.
    if (typed && !event.altKey) {
      take();
      keys.send(event.key === " " ? "space" : event.key);
      return;
    }
    // Everything else is xterm's to spell. What it leaves alone is either a
    // character the platform composed (Option on a Mac), sent as typed, or not
    // a terminal key at all (a dead key starting an accent), which is left to
    // run its course into the field that now has focus.
    if (replayKeyOnTerminal(pad.parentElement?.querySelector(":scope > .full-terminal-host"), event)) take();
    else if (typed) {
      take();
      keys.send(event.key);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isDesk() || !hardwareKeyboard()) return;
    if (event.defaultPrevented || event.isComposing || composeIME() || hasOpenDialog()) return;
    const pressed = from(event);
    // A focused button keeps the keys it has a use for; the rest are the page's.
    if (pressed === "control" && controlKeepsKey(event)) return;
    const origin = pressed === "control" ? "page" : pressed;
    const live = composeLive();
    if (!origin) return;
    const field = origin === "field" ? event.target as HTMLTextAreaElement : null;
    const take = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const send = (key: string): void => {
      take();
      keys.send(key);
    };
    if (live) {
      // A line break, from xterm or replayed onto it: taken here, before xterm sends Enter for it.
      if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (origin === "page") keys.focus();
        send("ctrl+j");
      } else if (origin === "page") sendLive(event, take);
      return;
    }
    // A Tab cannot complete words that are not in the terminal yet: with a
    // draft it leaves the field, and only an empty prompt sends it on.
    if (event.key === "Tab" && (!field || event.shiftKey || composeDraft())) return;
    const chord = event.ctrlKey || event.metaKey || event.altKey;
    if ((event.key === "PageUp" || event.key === "PageDown") && !event.shiftKey && !chord) {
      take();
      keys.page(event.key === "PageUp" ? "up" : "down");
      return;
    }
    if (event.key === "Enter") {
      // The field sends and breaks lines by its own rules.
      if (field || event.shiftKey) return;
      take();
      requestFullTerminalPadEnter(pad);
      return;
    }
    if (event.key === "Backspace") {
      // With nothing drafted there is nothing of the field's to delete.
      if (field && !composeDraft()) send("backspace");
      return;
    }
    if (event.ctrlKey && !event.metaKey && /^[a-z]$/i.test(event.key)) {
      if (event.shiftKey) return;
      const letter = event.key.toLowerCase();
      if (field && letter === "c" && field.selectionStart !== field.selectionEnd) return;
      if (field && fieldKeepsControlChord(letter, Boolean(composeDraft()))) return;
      // Text dragged out of the terminal: Ctrl+C copies it instead of interrupting.
      if (letter === "c" && !macPlatform() && !event.altKey && keys.copySelection?.()) {
        take();
        return;
      }
      send(`ctrl+${letter}`);
      return;
    }
    if (chord) return;
    const named = TERMINAL_KEYS[event.key];
    if (named) {
      // A draft keeps the arrows that move its caret.
      if (field && composeDraft() && event.key.startsWith("Arrow")) return;
      send(named);
      return;
    }
    if (field || event.key.length !== 1) return;
    take();
    typeIntoFullTerminalCompose(pad, event.key);
  };

  // A press on something that cannot hold focus leaves it on the page. Once the
  // press has settled (its own handler may close the column it was in), a live
  // terminal takes the keyboard back, by the rule it takes it under on arrival:
  // not from another column, a dialog, or the button a key just closed a
  // surface back to.
  let reclaim = 0;
  const onClick = (): void => {
    window.cancelAnimationFrame(reclaim);
    reclaim = window.requestAnimationFrame(() => {
      if (!composeLive() || !isDesk() || !hardwareKeyboard() || !sessionMayTakeFocus()) return;
      // Text the press selected (the title, a hint) stays selected: focusing a field would drop it.
      if (window.getSelection()?.isCollapsed === false) return;
      const active = document.activeElement;
      if (!active || active === document.body || active === document.documentElement) keys.focus();
    });
  };

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  return () => {
    window.cancelAnimationFrame(reclaim);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onClick, true);
  };
}
