import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";

const {
  TERTIARY_KEYS, bindModifier, chordModifierActive, clearModifiers, modifierIsActive,
  pressModifier, releaseModifier, withKeyboardModifiers, withModifiers,
} = await import("./keypad.ts");

const bindings: Array<{ destroy(): void }> = [];
beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  act(clearModifiers);
  appRoot().replaceChildren();
});
afterEach(() => {
  act(() => {
    for (const binding of bindings.splice(0)) binding.destroy();
    clearModifiers();
  });
  appRoot().replaceChildren();
});

describe("pad modifiers", () => {
  test("the modifier row is the four holdable modifiers, with Alt named once", () => {
    expect(TERTIARY_KEYS.map((key) => key.label)).toEqual(["Ctrl", "Alt", "Shift", "Cmd"]);
    expect(TERTIARY_KEYS.every((key) => key.modifier)).toBe(true);
    expect(TERTIARY_KEYS.find((key) => key.modifier === "alt")?.aria).toBe("Alt / Option");
  });

  test("Ctrl or Cmd turns a letter into ctrl+letter and preserves modified arrows", () => {
    pressModifier("ctrl");
    expect(withModifiers("c")).toEqual(["ctrl+c"]);
    clearModifiers();
    pressModifier("ctrl");
    expect(withModifiers("ctrl+a")).toEqual(["ctrl+a"]);
    clearModifiers();
    pressModifier("cmd");
    expect(withModifiers("k")).toEqual(["ctrl+k"]);
    clearModifiers();
    pressModifier("ctrl");
    expect(withModifiers("up")).toEqual(["ctrl+up"]);
  });

  test("Opt preserves terminal chords, Shift uppercases", () => {
    pressModifier("alt");
    expect(withModifiers("left")).toEqual(["alt+left"]);
    clearModifiers();
    pressModifier("alt");
    expect(withModifiers("right")).toEqual(["alt+right"]);
    clearModifiers();
    pressModifier("alt");
    expect(withModifiers("backspace")).toEqual(["alt+backspace"]);
    clearModifiers();
    pressModifier("shift");
    expect(withModifiers("a")).toEqual(["A"]);
  });

  test("a tap latches until the next pad key, then clears", () => {
    pressModifier("ctrl");
    releaseModifier("ctrl");
    expect(withModifiers("c")).toEqual(["ctrl+c"]);
    expect(withModifiers("c")).toEqual(["c"]);
  });

  test("a chord modifier follows the field keyboard and one typed key spends it", () => {
    pressModifier("ctrl");
    releaseModifier("ctrl");
    expect(chordModifierActive()).toBe(true);
    expect(withKeyboardModifiers("s")).toEqual(["ctrl+s"]);
    expect(chordModifierActive()).toBe(false);
    expect(withKeyboardModifiers("s")).toBeNull();
  });

  test("Shift alone belongs to the field keyboard, not to a typed chord", () => {
    pressModifier("shift");
    releaseModifier("shift");
    expect(chordModifierActive()).toBe(false);
    expect(withKeyboardModifiers("s")).toBeNull();
    expect(modifierIsActive("shift")).toBe(true);
    expect(withModifiers("s")).toEqual(["S"]);
  });

  test("a locked chord stays for the next typed key until it is cleared", () => {
    pressModifier("ctrl");
    releaseModifier("ctrl");
    pressModifier("ctrl");
    releaseModifier("ctrl");
    expect(withKeyboardModifiers("c")).toEqual(["ctrl+c"]);
    expect(chordModifierActive()).toBe(true);
    expect(withKeyboardModifiers("d")).toEqual(["ctrl+d"]);
    clearModifiers();
    expect(chordModifierActive()).toBe(false);
  });

  test("a typed key with no terminal bytes keeps the edit and drops the latch", () => {
    pressModifier("ctrl");
    releaseModifier("ctrl");
    expect(withKeyboardModifiers(",")).toEqual([]);
    expect(chordModifierActive()).toBe(false);
  });

  test("pointerup followed by lost capture latches once; cancelling never latches", () => {
    const button = happy.document.createElement("button");
    appRoot().append(button);
    bindings.push(bindModifier(button as unknown as HTMLElement, "ctrl"));
    const pointer = (type: string) => button.dispatchEvent(new happy.PointerEvent(type, {
      pointerId: 1, button: 0, bubbles: true, cancelable: true,
    }));
    pointer("pointerdown");
    pointer("pointerup");
    pointer("lostpointercapture");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(withModifiers("c")).toEqual(["ctrl+c"]);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    pointer("pointerdown");
    pointer("pointercancel");
    pointer("lostpointercapture");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(withModifiers("c")).toEqual(["c"]);
    button.click();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    button.click();
    expect(button.dataset.locked).toBe("true");
    button.click();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.remove();
  });

  test("clearing modifiers during a hold prevents a late release from relatching", () => {
    pressModifier("ctrl");
    clearModifiers();
    releaseModifier("ctrl");
    expect(withModifiers("c")).toEqual(["c"]);
  });

  test("destroy unregisters the button and drops permanent press listeners", () => {
    const button = happy.document.createElement("button");
    appRoot().append(button);
    const binding = bindModifier(button as unknown as HTMLElement, "ctrl");
    bindings.push(binding);
    binding.destroy();
    pressModifier("ctrl");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.dispatchEvent(new happy.PointerEvent("pointerdown", {
      pointerId: 1, button: 0, bubbles: true, cancelable: true,
    }));
    expect(button.classList.contains("is-pressed")).toBe(false);
    expect(button.classList.contains("on")).toBe(false);
    button.remove();
    clearModifiers();
  });
});
