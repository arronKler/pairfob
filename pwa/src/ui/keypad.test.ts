import { describe, expect, test, afterEach } from "bun:test";
import { Window } from "happy-dom";

const happy = new Window({ url: "https://pairfob.com/pair" });
const g = globalThis as unknown as Record<string, unknown>;
g.document = happy.document;
g.HTMLElement = happy.HTMLElement;
g.HTMLButtonElement = happy.HTMLButtonElement;
g.Node = happy.Node;

const { TERTIARY_KEYS, clearModifiers, pressModifier, releaseModifier, withModifiers } = await import("./keypad.ts");

afterEach(() => clearModifiers());

describe("pad modifiers", () => {
  test("the extra row is holdable modifiers plus readline chords Herdr accepts", () => {
    expect(TERTIARY_KEYS.filter((key) => key.modifier).map((key) => key.label)).toEqual(["Ctrl", "Opt", "Shift", "Cmd"]);
    expect(TERTIARY_KEYS.map((key) => key.key)).toContain("ctrl+a");
    expect(TERTIARY_KEYS.map((key) => key.key)).toContain("ctrl+e");
    expect(TERTIARY_KEYS.map((key) => key.key)).toContain("ctrl+k");
  });

  test("Ctrl or Cmd turns a letter into ctrl+letter and ignores illegal chords", () => {
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
    expect(withModifiers("up")).toEqual([]);
  });

  test("Opt maps onto esc+letter / readline word kills, Shift uppercases", () => {
    pressModifier("alt");
    expect(withModifiers("left")).toEqual(["esc", "b"]);
    clearModifiers();
    pressModifier("alt");
    expect(withModifiers("right")).toEqual(["esc", "f"]);
    clearModifiers();
    pressModifier("alt");
    expect(withModifiers("backspace")).toEqual(["ctrl+w"]);
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
});
