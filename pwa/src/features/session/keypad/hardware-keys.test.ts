import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { hardwareLiveKey } from "./hardware-keys";
import { encodeTerminalKey, requiresTerminalText } from "./terminal-keys";

let original = "";
const platform = (value: string): void => { Object.defineProperty(navigator, "platform", { value, configurable: true }); };
beforeEach(async () => {
  await resetBoardTestDOM();
  original = navigator.platform;
});
afterEach(() => platform(original));

const key = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent("keydown", { key: name, ...init });

describe("the hardware keys the pad has no cap for", () => {
  test("navigation and function keys are named whatever modifiers they carry", () => {
    expect(hardwareLiveKey(key("Home"))).toBe("home");
    expect(hardwareLiveKey(key("End", { shiftKey: true }))).toBe("shift+end");
    expect(hardwareLiveKey(key("Delete", { ctrlKey: true }))).toBe("ctrl+delete");
    expect(hardwareLiveKey(key("Insert"))).toBe("insert");
    expect(hardwareLiveKey(key("F1"))).toBe("f1");
    expect(hardwareLiveKey(key("F12", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe("ctrl+alt+shift+f12");
    // F13 and up are not on the encoder's table.
    expect(hardwareLiveKey(key("F13"))).toBeNull();
  });

  test("the keys the pad has are named only once a modifier makes them something the pad cannot send", () => {
    for (const name of ["ArrowUp", "ArrowLeft", "Enter", "Escape", "PageUp", "PageDown"]) {
      expect(hardwareLiveKey(key(name)), name).toBeNull();
    }
    expect(hardwareLiveKey(key("ArrowUp", { shiftKey: true }))).toBe("shift+up");
    expect(hardwareLiveKey(key("ArrowRight", { ctrlKey: true }))).toBe("ctrl+right");
    expect(hardwareLiveKey(key("ArrowLeft", { altKey: true, shiftKey: true }))).toBe("alt+shift+left");
    expect(hardwareLiveKey(key("Backspace", { altKey: true }))).toBe("alt+backspace");
    expect(hardwareLiveKey(key("Enter", { altKey: true }))).toBe("alt+enter");
    expect(hardwareLiveKey(key("PageUp", { ctrlKey: true }))).toBe("ctrl+pageup");
    // Shift with a page key is not the program's.
    expect(hardwareLiveKey(key("PageUp", { shiftKey: true }))).toBeNull();
  });

  test("Backspace, Tab and back-tab are the program's wherever they are pressed, and Shift+Enter is a line feed", () => {
    expect(hardwareLiveKey(key("Backspace"))).toBe("backspace");
    // A terminal sends the same delete with Shift held.
    expect(hardwareLiveKey(key("Backspace", { shiftKey: true }))).toBe("backspace");
    expect(hardwareLiveKey(key("Tab"))).toBe("tab");
    expect(hardwareLiveKey(key("Tab", { shiftKey: true }))).toBe("shift+tab");
    expect(encodeTerminalKey("shift+tab")).toBe("\x1b[Z");
    expect(hardwareLiveKey(key("Tab", { altKey: true }))).toBe("tab");
    // The line break agent prompts read as "new line, do not send"; Ctrl or Alt with Enter keep their own bytes.
    expect(hardwareLiveKey(key("Enter", { shiftKey: true }))).toBe("ctrl+j");
    expect(encodeTerminalKey("ctrl+j")).toBe("\n");
    expect(hardwareLiveKey(key("Enter", { shiftKey: true, altKey: true }))).toBe("alt+shift+enter");
    expect(hardwareLiveKey(key("Tab", { metaKey: true }))).toBeNull();
  });

  test("what a terminal leaves to the browser or drops is not named: paste and copy on Insert, Option with a function key on a Mac", () => {
    expect(hardwareLiveKey(key("Insert", { shiftKey: true }))).toBeNull();
    expect(hardwareLiveKey(key("Insert", { ctrlKey: true }))).toBeNull();
    platform("MacIntel");
    expect(hardwareLiveKey(key("F5", { altKey: true }))).toBeNull();
    expect(hardwareLiveKey(key("F5", { altKey: true, ctrlKey: true }))).toBe("ctrl+alt+f5");
    platform("Win32");
    expect(hardwareLiveKey(key("F5", { altKey: true }))).toBe("alt+f5");
  });

  test("Ctrl with punctuation is its control byte; Ctrl with a letter is left to the rule it already has", () => {
    expect(hardwareLiveKey(key("[", { ctrlKey: true }))).toBe("ctrl+[");
    expect(hardwareLiveKey(key(" ", { ctrlKey: true }))).toBe("ctrl+space");
    expect(hardwareLiveKey(key("\\", { ctrlKey: true }))).toBe("ctrl+\\");
    expect(hardwareLiveKey(key("c", { ctrlKey: true }))).toBeNull();
    expect(hardwareLiveKey(key("1", { ctrlKey: true }))).toBeNull();
  });

  test("Alt is Meta everywhere but on a Mac, where Option composes a character that is typed", () => {
    platform("Win32");
    expect(hardwareLiveKey(key("b", { altKey: true }))).toBe("alt+b");
    // The character already carries its Shift.
    expect(hardwareLiveKey(key("F", { altKey: true, shiftKey: true }))).toBe("alt+F");
    expect(encodeTerminalKey("alt+F")).toBe("\x1bF");
    // AltGr arrives as Ctrl+Alt and types its character.
    expect(hardwareLiveKey(key("@", { altKey: true, ctrlKey: true }))).toBeNull();
    platform("MacIntel");
    expect(hardwareLiveKey(key("∫", { altKey: true }))).toBeNull();
    // An Option+arrow is a key, not a character, on a Mac too.
    expect(hardwareLiveKey(key("ArrowLeft", { altKey: true }))).toBe("alt+left");
  });

  test("a character, and anything with Command, is not named here", () => {
    expect(hardwareLiveKey(key("a"))).toBeNull();
    expect(hardwareLiveKey(key("A", { shiftKey: true }))).toBeNull();
    expect(hardwareLiveKey(key("Home", { metaKey: true }))).toBeNull();
    expect(hardwareLiveKey(key("ArrowLeft", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(hardwareLiveKey(key("Shift", { shiftKey: true }))).toBeNull();
  });

  test("every name it gives is one the encoder writes, as a PTY write", () => {
    platform("Win32");
    const presses: Array<[string, KeyboardEventInit]> = [
      ["Home", {}], ["End", { ctrlKey: true }], ["Delete", { altKey: true }], ["Insert", {}], ["F7", { shiftKey: true }],
      ["ArrowDown", { shiftKey: true }], ["Backspace", { ctrlKey: true }], ["Escape", { altKey: true }], ["PageDown", { ctrlKey: true }],
      ["]", { ctrlKey: true }], ["x", { altKey: true }],
    ];
    for (const [name, init] of presses) {
      const named = hardwareLiveKey(key(name, init));
      expect(named, name).not.toBeNull();
      expect(requiresTerminalText(named!), named!).toBe(true);
      expect(encodeTerminalKey(named!).length, named!).toBeGreaterThan(0);
    }
  });
});
