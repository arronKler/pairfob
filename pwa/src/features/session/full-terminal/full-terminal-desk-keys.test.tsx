import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { PaneComposePreferenceRestorer } from "../../../../test-support/preferences-restore";
import { appRoot } from "../../../app/dom-root";
import { resetInputMode } from "../../../app/input-mode";
import { bindKeyboardZones } from "../../../lib/dom";
import { setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { clearModifiers, pressModifier, releaseModifier } from "../keypad/keypad";
import { composeDraft, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from "../compose-store";
import { noteSessionChosen } from "../focus";
import { selectPane } from "../session-store";
import { emulateTouchDevice } from "../touch-realm";

const { notifyFullTerminalKeyboard } = await import("./full-terminal-input");
const { FullTerminalPad } = await import("./full-terminal-pad");

/**
 * A complete terminal in 组字 with a hardware keyboard beside the list: keys
 * pressed with the terminal or the page focused reach the draft, the send, the
 * paging and the running program, as they do in the guided session. Nothing
 * changes on a phone.
 */
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function paint(size: { width: number; height: number }, hardwareKeyboard = true) {
  happy.happyDOM.setWindowSize(size);
  const sent: Array<[string, boolean]> = [];
  const paged: string[] = [];
  /** Keys handed to the terminal by their pad names, as the key row hands them. */
  const keyed: string[] = [];
  /** Times the terminal was handed the keyboard back. */
  const focused = { count: 0, takes: [] as boolean[] };
  const kb = { toggle() {}, open(take = true) { focused.count++; focused.takes.push(take); }, close() {}, isOpen: () => false };
  const options = {
    sendKey: (key: string) => { keyed.push(key); }, keyboard: kb, hardwareKeyboard,
    sendCompose: (text: string, enter: boolean) => { sent.push([text, enter]); return true; },
  };
  const onPage = (direction: "up" | "down"): void => { paged.push(direction); };
  const render = (controls: typeof options): void => {
    act(() => {
      renderReact(createElement("div", { className: "full-terminal-root" },
        createElement("div", { className: "full-terminal-host" },
          createElement("textarea", { className: "xterm-helper-textarea", readOnly: true }),
          createElement("button", { className: "full-terminal-state-retry" })),
        createElement(FullTerminalPad, { options: controls, onPage })));
    });
  };
  render(options);
  /** The controller's next read of the keyboard: a tablet's first physical key. */
  const proveKeyboard = (): void => render({ ...options, hardwareKeyboard: true });
  return { sent, paged, keyed, focused, proveKeyboard };
}

/** A list beside the session, with a row the reader can press. */
function rail(): { rail: HTMLElement; row: HTMLButtonElement } {
  restore.push(bindKeyboardZones(document));
  const nav = document.createElement("nav");
  nav.className = "rail";
  const row = document.createElement("button");
  nav.append(row);
  appRoot().append(nav);
  return { rail: nav, row };
}

const frame = () => act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });

const field = () => appRoot().querySelector<HTMLTextAreaElement>(".full-terminal-compose-input")!;
const xtermField = () => appRoot().querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

const settle = () => act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });

/**
 * xterm on its own field: it records the keydown it is given and, like xterm,
 * cancels the keys it sends. `leaves` are keys it lets through (a dead key, a
 * character the platform composes with Option).
 */
function xtermTakes(leaves: readonly string[] = []): string[] {
  const got: string[] = [];
  const onKeyDown = (event: KeyboardEvent): void => {
    const chord = `${event.ctrlKey ? "ctrl+" : ""}${event.altKey ? "alt+" : ""}${event.shiftKey ? "shift+" : ""}`;
    got.push(`${chord}${event.key}#${event.keyCode}`);
    if (!leaves.includes(event.key)) event.preventDefault();
  };
  const el = xtermField();
  el.addEventListener("keydown", onKeyDown);
  restore.push(() => el.removeEventListener("keydown", onKeyDown));
  return got;
}

const composeRestorer = new PaneComposePreferenceRestorer();
let restore: Array<() => void> = [];

beforeEach(async () => {
  await resetBoardTestDOM();
  resetInputMode();
  selectPane("p1");
  composeRestorer.capture("p1");
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeLive(false);
  setComposeDraft("");
});

afterEach(async () => {
  unmountReact();
  for (const undo of restore) undo();
  restore = [];
  for (const node of document.querySelectorAll("dialog, .rail")) node.remove();
  clearModifiers();
  await act(async () => {
    notifyFullTerminalKeyboard(false);
    setComposeDraft("");
    setComposeFocused(false);
    setComposeIME(false);
    setComposeLive(false);
  });
  composeRestorer.restore();
  selectPane("");
  resetInputMode();
  happy.happyDOM.setWindowSize(PHONE);
});

describe("typing at a complete terminal in 组字", () => {
  test("a printable key on the page starts the draft and moves the caret into the field", () => {
    paint(DESK);
    expectDifferentNode(document.activeElement, field());
    const first = press(document.body, "l");
    expect(first.defaultPrevented).toBeTrue();
    expect(composeDraft()).toBe("l");
    expect(field().value).toBe("l");
    expectSameNode(document.activeElement, field());
    expect(field().selectionStart).toBe(1);

    // From here the field types for itself.
    const second = press(field(), "s");
    expect(second.defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("l");
  });

  test("a key that lands on xterm's switched-off field goes to the draft and never to xterm", () => {
    paint(DESK);
    let reachedXterm = 0;
    xtermField().addEventListener("keydown", () => { reachedXterm++; });
    press(xtermField(), "a");
    press(xtermField(), " ");
    expect(composeDraft()).toBe("a ");
    expect(reachedXterm).toBe(0);
    expectSameNode(document.activeElement, field());
  });

  test("Enter on the page sends what is drafted, and a bare Enter when nothing is", async () => {
    const { sent } = paint(DESK);
    press(document.body, "Enter");
    await settle();
    expect(sent).toEqual([["", true]]);

    act(() => { setComposeDraft("ls -la"); field().value = "ls -la"; });
    press(document.body, "Enter");
    await settle();
    expect(sent).toEqual([["", true], ["ls -la", true]]);
    expect(composeDraft()).toBe("");
  });

  test("PageUp and PageDown page the session from the page and from the field", () => {
    const { paged } = paint(DESK);
    expect(press(document.body, "PageUp").defaultPrevented).toBeTrue();
    act(() => field().focus());
    expect(press(field(), "PageDown").defaultPrevented).toBeTrue();
    expect(paged).toEqual(["up", "down"]);
    // Shift+PageUp is the browser's own text selection in the field.
    expect(press(field(), "PageUp", { shiftKey: true }).defaultPrevented).toBeFalse();
    expect(paged).toEqual(["up", "down"]);
  });

  test("the browser's shortcuts, buttons and other columns keep their keys", () => {
    const { sent, paged, keyed } = paint(DESK);
    expect(press(document.body, "k", { metaKey: true }).defaultPrevented).toBeFalse();
    expect(press(document.body, "c", { metaKey: true }).defaultPrevented).toBeFalse();
    expect(press(document.body, "ArrowLeft", { altKey: true }).defaultPrevented).toBeFalse();
    expect(press(document.body, "c", { ctrlKey: true, metaKey: true }).defaultPrevented).toBeFalse();
    // Enter and Space on a button over the terminal or in the dock are that button's.
    expect(press(appRoot().querySelector<HTMLElement>(".full-terminal-state-retry")!, "Enter").defaultPrevented).toBeFalse();
    expect(press(appRoot().querySelector<HTMLElement>(".dock-keys-btn")!, " ").defaultPrevented).toBeFalse();

    // The list was the last thing pressed: focus is on the page, the keys are still the list's.
    restore.push(bindKeyboardZones(document));
    const rail = document.createElement("nav");
    rail.className = "rail";
    appRoot().append(rail);
    act(() => { rail.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(press(document.body, "a").defaultPrevented).toBeFalse();
    expect(press(document.body, "PageUp").defaultPrevented).toBeFalse();
    expect(press(document.body, "Escape").defaultPrevented).toBeFalse();
    expect(press(document.body, "c", { ctrlKey: true }).defaultPrevented).toBeFalse();
    expect(press(document.body, "ArrowUp").defaultPrevented).toBeFalse();

    expect(composeDraft()).toBe("");
    expect(sent).toEqual([]);
    expect(paged).toEqual([]);
    expect(keyed).toEqual([]);
  });

  test("an open dialog keeps every key", () => {
    const { keyed } = paint(DESK);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(press(document.body, "a").defaultPrevented).toBeFalse();
    // Escape closes the dialog; it must not also reach the program.
    expect(press(document.body, "Escape").defaultPrevented).toBeFalse();
    expect(press(document.body, "c", { ctrlKey: true }).defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("");
    expect(keyed).toEqual([]);
  });

  test("live input is xterm's: nothing is taken from it", () => {
    const { paged, keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    focused.count = 0;
    expect(press(xtermField(), "a").defaultPrevented).toBeFalse();
    expect(press(xtermField(), "PageUp").defaultPrevented).toBeFalse();
    expect(press(xtermField(), "Escape").defaultPrevented).toBeFalse();
    expect(press(xtermField(), "c", { ctrlKey: true }).defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("");
    expect(paged).toEqual([]);
    expect(keyed).toEqual([]);
    expect(focused.count).toBe(0);
  });
});

describe("a button of the session column left focused by a click", () => {
  const controls = () => [".dock-keys-btn", ".full-terminal-state-retry"].map((selector) => appRoot().querySelector<HTMLElement>(selector)!);

  test("in 组字 a typed character starts the draft and moves the caret into the field", () => {
    const { keyed } = paint(DESK);
    const [keys, retry] = controls();
    expect(press(keys!, "g").defaultPrevented).toBeTrue();
    expect(press(retry!, "O", { shiftKey: true }).defaultPrevented).toBeTrue();
    expect(composeDraft()).toBe("gO");
    expectSameNode(document.activeElement, field());
    expect(keyed).toEqual([]);
  });

  test("in 实时 a typed character goes to the terminal, which takes the keyboard back", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    focused.count = 0;
    const button = appRoot().querySelector<HTMLElement>(".dock-keys-btn")!;
    expect(press(button, "l").defaultPrevented).toBeTrue();
    expect(keyed).toEqual(["l"]);
    expect(focused.count).toBe(1);
  });

  test("it keeps Enter and Space for itself and Tab and Shift+Tab to move on, in either mode", () => {
    const { sent, paged, keyed, focused } = paint(DESK);
    for (const live of [false, true]) {
      act(() => { setComposeLive(live); });
      focused.count = 0;
      for (const button of controls()) {
        for (const [key, init] of [["Enter", {}], [" ", {}], ["Tab", {}], ["Tab", { shiftKey: true }]] as Array<[string, KeyboardEventInit]>) {
          expect(press(button!, key, init).defaultPrevented, `${live ? "live" : "batch"} ${key}`).toBeFalse();
        }
      }
      expect(focused.count).toBe(0);
    }
    expect(composeDraft()).toBe("");
    expect(sent).toEqual([]);
    expect(paged).toEqual([]);
    expect(keyed).toEqual([]);
  });

  test("in 组字 Esc, the arrows, Ctrl with a letter and paging are routed from it as from the page", () => {
    const { sent, paged, keyed } = paint(DESK);
    for (const button of controls()) {
      expect(press(button!, "Escape").defaultPrevented).toBeTrue();
      expect(press(button!, "ArrowLeft").defaultPrevented).toBeTrue();
      expect(press(button!, "c", { ctrlKey: true }).defaultPrevented).toBeTrue();
      expect(press(button!, "PageUp").defaultPrevented).toBeTrue();
      // What the page does not send, the button does not either; the browser's chords stay its own.
      for (const [key, init] of [["Backspace", {}], ["Home", {}], ["F5", {}], ["v", { metaKey: true }], ["x", { altKey: true }]] as Array<[string, KeyboardEventInit]>) {
        expect(press(button!, key, init).defaultPrevented, key).toBeFalse();
      }
    }
    expect(keyed).toEqual(["esc", "left", "ctrl+c", "esc", "left", "ctrl+c"]);
    expect(paged).toEqual(["up", "up"]);
    expect(sent).toEqual([]);
    expect(composeDraft()).toBe("");
  });

  test("in 实时 every other key goes to the terminal, which takes the keyboard back", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const replayed = xtermTakes();
    focused.count = 0;
    const button = appRoot().querySelector<HTMLElement>(".dock-keys-btn")!;
    for (const [key, init] of [
      ["Escape", { keyCode: 27 }], ["Backspace", { keyCode: 8 }], ["ArrowUp", { keyCode: 38 }], ["c", { ctrlKey: true, keyCode: 67 }],
      ["Home", { keyCode: 36 }], ["F5", { keyCode: 116 }],
    ] as Array<[string, KeyboardEventInit]>) {
      expect(press(button, key, init).defaultPrevented, key).toBeTrue();
    }
    // xterm spells them: nothing is sent by name from here.
    expect(replayed).toEqual(["Escape#27", "Backspace#8", "ArrowUp#38", "ctrl+c#67", "Home#36", "F5#116"]);
    expect(keyed).toEqual([]);
    expect(focused.count).toBe(6);
  });

  test("a button in the list or under a dialog passes nothing on", () => {
    const { keyed } = paint(DESK);
    const { row } = rail();
    expect(press(row, "a").defaultPrevented).toBeFalse();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(press(appRoot().querySelector<HTMLElement>(".dock-keys-btn")!, "a").defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("");
    expect(keyed).toEqual([]);
  });
});

describe("a live terminal whose focus dropped to the page", () => {
  test("a key pressed there reaches the program, and the terminal takes the keyboard back", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const replayed = xtermTakes();
    focused.count = 0;
    for (const [key, init] of [
      ["a", {}], ["Z", { shiftKey: true }], [" ", {}], ["Enter", { keyCode: 13 }], ["Backspace", { keyCode: 8 }],
      ["Escape", { keyCode: 27 }], ["ArrowUp", { keyCode: 38 }], ["c", { ctrlKey: true, keyCode: 67 }],
    ] as Array<[string, KeyboardEventInit]>) {
      expect(press(document.body, key, init).defaultPrevented, key).toBeTrue();
    }
    // A character goes the way the key row sends one; every other key is replayed on xterm, which spells it.
    expect(keyed).toEqual(["a", "Z", "space"]);
    expect(replayed).toEqual(["Enter#13", "Backspace#8", "Escape#27", "ArrowUp#38", "ctrl+c#67"]);
    expect(focused.count).toBe(8);
    expect(composeDraft()).toBe("");
  });

  test("no press is dropped: the keys the key row has no name for are replayed on xterm with their modifiers", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const replayed = xtermTakes();
    focused.count = 0;
    const keys: Array<[string, KeyboardEventInit]> = [
      ["Home", { keyCode: 36 }], ["End", { keyCode: 35 }], ["PageUp", { keyCode: 33 }], ["PageDown", { keyCode: 34 }],
      ["Delete", { keyCode: 46 }], ["Insert", { keyCode: 45 }], ["F1", { keyCode: 112 }], ["F12", { keyCode: 123 }],
      ["ArrowUp", { keyCode: 38, shiftKey: true }], ["ArrowLeft", { keyCode: 37, altKey: true }],
      ["ArrowRight", { keyCode: 39, ctrlKey: true }], ["Backspace", { keyCode: 8, altKey: true }],
      ["[", { keyCode: 219, ctrlKey: true }],
    ];
    for (const [key, init] of keys) expect(press(document.body, key, init).defaultPrevented, key).toBeTrue();
    expect(replayed).toEqual([
      "Home#36", "End#35", "PageUp#33", "PageDown#34", "Delete#46", "Insert#45", "F1#112", "F12#123",
      "shift+ArrowUp#38", "alt+ArrowLeft#37", "ctrl+ArrowRight#39", "alt+Backspace#8", "ctrl+[#219",
    ]);
    // xterm sent them; the key row was not asked to guess.
    expect(keyed).toEqual([]);
    expect(focused.count).toBe(keys.length);
  });

  test("the replayed key is a keydown on xterm's own field that xterm can read", () => {
    paint(DESK);
    act(() => { setComposeLive(true); });
    const seen: KeyboardEvent[] = [];
    xtermField().addEventListener("keydown", (event) => { seen.push(event); event.preventDefault(); });
    press(document.body, "F5", { keyCode: 116, code: "F5", shiftKey: true });
    expect(seen).toHaveLength(1);
    const [event] = seen;
    expectSameNode(event.target, xtermField());
    expect([event.key, event.code, event.keyCode, event.which]).toEqual(["F5", "F5", 116, 116]);
    expect([event.shiftKey, event.ctrlKey, event.altKey, event.metaKey]).toEqual([true, false, false, false]);
    expect(event.bubbles && event.cancelable).toBeTrue();
  });

  test("what xterm leaves alone: a composed character is sent as typed, a dead key runs its course", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const replayed = xtermTakes(["∫", "Dead"]);
    focused.count = 0;
    // Option+B on a Mac: xterm waits for the character, which the press already carries.
    expect(press(document.body, "∫", { altKey: true, keyCode: 66 }).defaultPrevented).toBeTrue();
    expect(keyed).toEqual(["∫"]);
    // Option+E starts an accent: the composition belongs to the field that now has focus.
    expect(press(document.body, "Dead", { altKey: true, keyCode: 69 }).defaultPrevented).toBeFalse();
    expect(keyed).toEqual(["∫"]);
    expect(replayed).toEqual(["alt+∫#66", "alt+Dead#69"]);
    expect(focused.count).toBe(2);
  });

  test("Tab and Shift+Tab are the program's from the page too, and a modifier on its own stays where it was pressed", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const replayed = xtermTakes();
    focused.count = 0;
    // xterm writes a tab and a back-tab (ESC [ Z) for them.
    expect(press(document.body, "Tab", { keyCode: 9 }).defaultPrevented).toBeTrue();
    expect(press(document.body, "Tab", { shiftKey: true, keyCode: 9 }).defaultPrevented).toBeTrue();
    expect(replayed).toEqual(["Tab#9", "shift+Tab#9"]);
    expect(focused.count).toBe(2);
    // A lone modifier types nothing.
    for (const [key, init] of [
      ["Shift", { shiftKey: true }], ["Alt", { altKey: true }], ["Meta", { metaKey: true }],
    ] as Array<[string, KeyboardEventInit]>) {
      expect(press(document.body, key, init).defaultPrevented, key).toBeFalse();
    }
    expect(focused.count).toBe(2);
    expect(keyed).toEqual([]);
    expect(replayed).toEqual(["Tab#9", "shift+Tab#9"]);
  });

  test("Shift+Enter is a line feed, from xterm itself and from the page: never the Enter xterm would send for it", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const replayed = xtermTakes();
    focused.count = 0;
    expect(press(xtermField(), "Enter", { shiftKey: true, keyCode: 13 }).defaultPrevented).toBeTrue();
    expect(focused.count).toBe(0);
    expect(press(document.body, "Enter", { shiftKey: true, keyCode: 13 }).defaultPrevented).toBeTrue();
    expect(focused.count).toBe(1);
    expect(keyed).toEqual(["ctrl+j", "ctrl+j"]);
    // Enter alone, and Enter with Ctrl or Alt, stay xterm's to send.
    expect(press(xtermField(), "Enter", { keyCode: 13 }).defaultPrevented).toBeTrue();
    expect(press(xtermField(), "Enter", { shiftKey: true, altKey: true, keyCode: 13 }).defaultPrevented).toBeTrue();
    expect(replayed).toEqual(["Enter#13", "alt+shift+Enter#13"]);
    expect(keyed).toEqual(["ctrl+j", "ctrl+j"]);
  });

  test("a Command chord stays the browser's, with the terminal focused for it to act on", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const replayed = xtermTakes();
    focused.count = 0;
    // Paste, copy, a Command+arrow: not taken and not sent, so the browser runs its own
    // command, and by then the terminal has the focus a paste needs.
    for (const [key, init] of [
      ["v", { metaKey: true }], ["c", { metaKey: true }], ["ArrowLeft", { metaKey: true }],
    ] as Array<[string, KeyboardEventInit]>) {
      expect(press(document.body, key, init).defaultPrevented, key).toBeFalse();
    }
    expect(focused.count).toBe(3);
    expect(keyed).toEqual([]);
    expect(replayed).toEqual([]);
  });

  test("the list, a dialog and glass with no keyboard keep it away", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    focused.count = 0;
    const { rail: list } = rail();
    act(() => { list.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(press(document.body, "a").defaultPrevented).toBeFalse();
    expect(press(document.body, "c", { ctrlKey: true }).defaultPrevented).toBeFalse();
    act(() => { appRoot().querySelector(".full-terminal-host")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(press(document.body, "a").defaultPrevented).toBeFalse();
    dialog.remove();
    restore.push(emulateTouchDevice());
    expect(press(document.body, "a").defaultPrevented).toBeFalse();
    expect(keyed).toEqual([]);
    expect(focused.count).toBe(0);
  });

  test("a press that lands on nothing focusable hands the keyboard back once it has settled", async () => {
    const { focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const { rail: list } = rail();
    focused.count = 0;
    const hint = document.createElement("p");
    appRoot().querySelector(".full-terminal-pad")!.append(hint);
    const click = (target: Element): void => {
      act(() => {
        target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    click(hint);
    expect(focused.count).toBe(0);
    await frame();
    expect(focused.count).toBe(1);

    // A button keeps the focus its press gave it, and the list keeps the keyboard.
    const button = appRoot().querySelector<HTMLElement>(".full-terminal-state-retry")!;
    act(() => { button.focus(); });
    click(button);
    await frame();
    act(() => { button.blur(); });
    click(list);
    await frame();
    expect(focused.count).toBe(1);

    // 组字 has no keyboard to hand back: its page keys are read where they land.
    act(() => { setComposeLive(false); });
    focused.count = 0;
    click(hint);
    await frame();
    expect(focused.count).toBe(0);
  });
});

describe("switching a complete terminal to 实时", () => {
  test("xterm takes the caret with the keys while the session holds the keyboard", () => {
    const { focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    expect(focused.takes).toEqual([true]);
  });

  test("the keys are xterm's but the caret stays where another column or a dialog has it", () => {
    const { focused } = paint(DESK);
    const { rail: list } = rail();
    act(() => { list.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    act(() => { setComposeLive(true); });
    expect(focused.takes).toEqual([false]);

    act(() => { setComposeLive(false); });
    act(() => { appRoot().querySelector(".full-terminal-host")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    act(() => { setComposeLive(true); });
    expect(focused.takes).toEqual([false, false]);
  });
});

describe("a keyboard that proves itself at a live terminal", () => {
  test("xterm gets the keys and no caret: focus follows the key, not the proof", () => {
    const { focused, keyed, proveKeyboard } = paint(DESK, false);
    act(() => { setComposeLive(true); });
    // Glass: nothing opens, nothing is focused.
    expect(focused.takes).toEqual([]);
    proveKeyboard();
    expect(focused.takes).toEqual([false]);
    // The key that proved it, pressed on the page, is xterm's and takes the caret with it.
    const replayed = xtermTakes();
    expect(press(document.body, "Escape", { keyCode: 27 }).defaultPrevented).toBeTrue();
    expect(replayed).toEqual(["Escape#27"]);
    expect(keyed).toEqual([]);
    expect(focused.takes).toEqual([false, true]);
  });
});

describe("the session's own row in the list, pressed and left focused", () => {
  test("its keys are the terminal's until the reader presses elsewhere; Enter and Space stay the row's", () => {
    const { keyed } = paint(DESK);
    const { rail: list, row } = rail();
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      row.focus();
    });
    // Just focus in the list: the list's.
    expect(press(row, "Escape").defaultPrevented).toBeFalse();

    act(() => { noteSessionChosen(); });
    expect(press(row, "Escape").defaultPrevented).toBeTrue();
    expect(press(row, "c", { ctrlKey: true }).defaultPrevented).toBeTrue();
    expect(press(row, "Enter").defaultPrevented).toBeFalse();
    expect(press(row, " ").defaultPrevented).toBeFalse();
    expect(keyed).toEqual(["esc", "ctrl+c"]);
    // A character starts the draft and takes the caret out of the list.
    expect(press(row, "l").defaultPrevented).toBeTrue();
    expect(composeDraft()).toBe("l");
    expectSameNode(document.activeElement, field());

    // Chosen again, then a press on the list: the keyboard is the list's.
    act(() => { row.focus(); noteSessionChosen(); });
    act(() => { list.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(press(row, "Escape").defaultPrevented).toBeFalse();
    expect(keyed).toEqual(["esc", "ctrl+c"]);
  });

  test("in 实时 the first key is sent and the terminal takes the keyboard", () => {
    const { keyed, focused } = paint(DESK);
    act(() => { setComposeLive(true); });
    const { row } = rail();
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      row.focus();
      noteSessionChosen();
    });
    const replayed = xtermTakes();
    focused.count = 0;
    expect(press(row, "Escape", { keyCode: 27 }).defaultPrevented).toBeTrue();
    expect(replayed).toEqual(["Escape#27"]);
    expect(keyed).toEqual([]);
    expect(focused.count).toBe(1);
  });

  test("glass with no keyboard proven routes nothing from the row", () => {
    restore.push(emulateTouchDevice());
    const { keyed } = paint(DESK);
    const { row } = rail();
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      row.focus();
      noteSessionChosen();
    });
    // The pad's own listener sees no proof: this suite binds no input mode.
    expect(press(row, "a").defaultPrevented).toBeFalse();
    expect(press(row, "Escape").defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("");
    expect(keyed).toEqual([]);
  });
});

describe("keys for the running program at a complete terminal in 组字", () => {
  test("Esc, the arrows and Ctrl with a letter pressed at the terminal go to the program, never to xterm or the draft", () => {
    const { keyed } = paint(DESK);
    let reachedXterm = 0;
    xtermField().addEventListener("keydown", () => { reachedXterm++; });
    for (const [key, init] of [
      ["Escape", {}], ["ArrowLeft", {}], ["ArrowUp", {}], ["c", { ctrlKey: true }], ["d", { ctrlKey: true }],
    ] as Array<[string, KeyboardEventInit]>) {
      expect(press(document.body, key, init).defaultPrevented, key).toBeTrue();
    }
    // Ctrl+Shift with a letter is no terminal key: left to the browser.
    expect(press(document.body, "D", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBeFalse();
    expect(press(xtermField(), "Escape").defaultPrevented).toBeTrue();
    expect(press(xtermField(), "ArrowDown").defaultPrevented).toBeTrue();
    expect(keyed).toEqual(["esc", "left", "up", "ctrl+c", "ctrl+d", "esc", "down"]);
    expect(reachedXterm).toBe(0);
    expect(composeDraft()).toBe("");
    expectDifferentNode(document.activeElement, field());
  });

  test("Tab outside the field moves focus, and keys the guided session does not send stay with the page", () => {
    const { keyed } = paint(DESK);
    expect(press(document.body, "Tab").defaultPrevented).toBeFalse();
    expect(press(document.body, "Tab", { shiftKey: true }).defaultPrevented).toBeFalse();
    expect(press(document.body, "Backspace").defaultPrevented).toBeFalse();
    expect(press(document.body, "Home").defaultPrevented).toBeFalse();
    expect(press(document.body, "F5").defaultPrevented).toBeFalse();
    expect(keyed).toEqual([]);
  });

  test("from the field, Esc and Ctrl with a letter go to the program whatever is drafted", () => {
    // On macOS, where editing a field is Command's work; elsewhere a draft keeps a few chords (below).
    const original = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    const { keyed } = paint(DESK);
    act(() => { field().focus(); });
    for (const draft of ["", "git status"]) {
      act(() => { setComposeDraft(draft); field().value = draft; });
      expect(press(field(), "Escape").defaultPrevented).toBeTrue();
      expect(press(field(), "a", { ctrlKey: true }).defaultPrevented).toBeTrue();
      expect(press(field(), "c", { ctrlKey: true }).defaultPrevented).toBeTrue();
      expect(composeDraft()).toBe(draft);
    }
    expect(keyed).toEqual(["esc", "ctrl+a", "ctrl+c", "esc", "ctrl+a", "ctrl+c"]);
    Object.defineProperty(navigator, "platform", { value: original, configurable: true });
  });

  test("Tab from the field completes at an empty prompt, and with a draft it leaves the field like any other", () => {
    const { keyed } = paint(DESK);
    act(() => { field().focus(); });
    // Nothing drafted: a shell or a TUI is waiting, and Tab is its completion key.
    expect(press(field(), "Tab").defaultPrevented).toBeTrue();
    expect(keyed).toEqual(["tab"]);
    // Words in the draft are not in the terminal yet, so there is nothing for Tab to complete:
    // the browser moves focus on, to the send button and everything after the field.
    act(() => { setComposeDraft("git sta"); field().value = "git sta"; });
    expect(press(field(), "Tab").defaultPrevented).toBeFalse();
    expect(keyed).toEqual(["tab"]);
    expect(composeDraft()).toBe("git sta");
    // Shift+Tab always backs out of the field, drafted or not.
    expect(press(field(), "Tab", { shiftKey: true }).defaultPrevented).toBeFalse();
    act(() => { setComposeDraft(""); field().value = ""; });
    expect(press(field(), "Tab", { shiftKey: true }).defaultPrevented).toBeFalse();
    expect(keyed).toEqual(["tab"]);
  });

  test("off macOS the field keeps paste, and select-all, cut, undo and redo while it holds a draft", () => {
    const original = navigator.platform;
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
    const { keyed } = paint(DESK);
    act(() => { field().focus(); });
    act(() => { setComposeDraft(""); field().value = ""; });
    // Nothing to select or undo: these are the program's (Ctrl+A is a shell's start of line).
    for (const letter of ["a", "x", "z", "y"]) expect(press(field(), letter, { ctrlKey: true }).defaultPrevented).toBeTrue();
    expect(press(field(), "v", { ctrlKey: true }).defaultPrevented).toBeFalse();
    act(() => { setComposeDraft("git status"); field().value = "git status"; });
    for (const letter of ["a", "x", "z", "y", "v"]) expect(press(field(), letter, { ctrlKey: true }).defaultPrevented).toBeFalse();
    // Every other chord still reaches the program, and so does everything typed outside the field.
    expect(press(field(), "r", { ctrlKey: true }).defaultPrevented).toBeTrue();
    expect(press(document.body, "v", { ctrlKey: true }).defaultPrevented).toBeTrue();
    expect(keyed).toEqual(["ctrl+a", "ctrl+x", "ctrl+z", "ctrl+y", "ctrl+r", "ctrl+v"]);
    Object.defineProperty(navigator, "platform", { value: original, configurable: true });
  });

  test("Backspace and the arrows are the draft's while there is one, and the program's once it is empty", () => {
    const { keyed } = paint(DESK);
    act(() => { field().focus(); setComposeDraft("ls"); field().value = "ls"; });
    expect(press(field(), "Backspace").defaultPrevented).toBeFalse();
    expect(press(field(), "ArrowLeft").defaultPrevented).toBeFalse();
    expect(press(field(), "ArrowUp").defaultPrevented).toBeFalse();
    expect(keyed).toEqual([]);

    act(() => { setComposeDraft(""); field().value = ""; });
    expect(press(field(), "Backspace").defaultPrevented).toBeTrue();
    expect(press(field(), "ArrowLeft").defaultPrevented).toBeTrue();
    expect(press(field(), "ArrowUp").defaultPrevented).toBeTrue();
    expect(keyed).toEqual(["backspace", "left", "up"]);
  });

  test("Ctrl+C on text selected in the field copies it instead of interrupting", () => {
    const { keyed } = paint(DESK);
    act(() => { field().focus(); setComposeDraft("npm test"); field().value = "npm test"; field().setSelectionRange(0, 3); });
    expect(press(field(), "c", { ctrlKey: true }).defaultPrevented).toBeFalse();
    expect(keyed).toEqual([]);
    act(() => { field().setSelectionRange(3, 3); });
    expect(press(field(), "c", { ctrlKey: true }).defaultPrevented).toBeTrue();
    expect(keyed).toEqual(["ctrl+c"]);
  });

  test("a modifier armed on the key row applies to the next typed key, as it does to a pressed one", () => {
    const { keyed } = paint(DESK);
    act(() => { pressModifier("shift"); releaseModifier("shift"); });
    press(document.body, "ArrowLeft");
    press(document.body, "ArrowLeft");
    expect(keyed).toEqual(["shift+left", "left"]);
  });

  test("an IME composing in the field keeps Esc and the arrows for its candidates", () => {
    const { keyed } = paint(DESK);
    act(() => { field().focus(); setComposeIME(true); });
    expect(press(field(), "Escape").defaultPrevented).toBeFalse();
    expect(press(field(), "ArrowDown").defaultPrevented).toBeFalse();
    act(() => { setComposeIME(false); });
    expect(press(field(), "Escape", { isComposing: true }).defaultPrevented).toBeFalse();
    expect(keyed).toEqual([]);
  });
});

describe("the phone and a touch tablet keep their own keyboard rules", () => {
  test("a phone-width window takes no page keys, whatever points at it", () => {
    const { paged, keyed } = paint(PHONE);
    expect(press(document.body, "a").defaultPrevented).toBeFalse();
    expect(press(document.body, "PageUp").defaultPrevented).toBeFalse();
    expect(press(document.body, "Escape").defaultPrevented).toBeFalse();
    expect(press(document.body, "c", { ctrlKey: true }).defaultPrevented).toBeFalse();
    act(() => field().focus());
    expect(press(field(), "Backspace").defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("");
    expect(paged).toEqual([]);
    expect(keyed).toEqual([]);
  });

  test("a tablet without a hardware keyboard takes none either", () => {
    restore.push(emulateTouchDevice());
    const { paged, keyed } = paint(DESK);
    // An on-screen keyboard's key arrives while a field is focused: no proof of a hardware one.
    act(() => field().focus());
    expect(press(field(), "PageUp").defaultPrevented).toBeFalse();
    // Its Backspace in an empty field deletes nothing, here or on the computer.
    expect(press(field(), "Backspace").defaultPrevented).toBeFalse();
    expect(paged).toEqual([]);
    expect(keyed).toEqual([]);
  });
});
