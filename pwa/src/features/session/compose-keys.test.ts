import { describe, expect, test } from "bun:test";
import "../../../test-support/dom";
import { fieldKeepsControlChord, withQuickCommand, withSlashCommand } from "./compose-keys";

describe("quick command insertion", () => {
  test("fills an empty draft", () => {
    expect(withQuickCommand("", 0, 0, "review")).toEqual({ next: "review", caret: 6 });
  });

  test("keeps words on both sides of the caret apart", () => {
    expect(withQuickCommand("AB", 1, 1, "review")).toEqual({ next: "A review B", caret: 8 });
  });

  test("adds no extra space next to existing whitespace", () => {
    expect(withQuickCommand("A B", 2, 2, "review")).toEqual({ next: "A review B", caret: 8 });
    expect(withQuickCommand("A", 1, 1, "review")).toEqual({ next: "A review", caret: 8 });
  });
});

describe("slash command insertion", () => {
  test("goes to the start and keeps the draft", () => {
    expect(withSlashCommand("fix the header", "/goal ").startsWith("/goal fix the header")).toBe(true);
  });
});

describe("control chords in the compose field", () => {
  const original = navigator.platform;
  const platform = (value: string) => Object.defineProperty(navigator, "platform", { value, configurable: true });

  test("on macOS every one of them is the program's", () => {
    platform("MacIntel");
    for (const letter of ["a", "c", "v", "x", "z"]) expect(fieldKeepsControlChord(letter, true)).toBe(false);
    platform(original);
  });

  test("elsewhere paste is the field's, and the editing chords are once there is a draft", () => {
    platform("Linux x86_64");
    expect(fieldKeepsControlChord("v", false)).toBe(true);
    expect(fieldKeepsControlChord("V", true)).toBe(true);
    for (const letter of ["a", "x", "z", "y"]) {
      expect(fieldKeepsControlChord(letter, false)).toBe(false);
      expect(fieldKeepsControlChord(letter, true)).toBe(true);
    }
    for (const letter of ["c", "d", "r", "l"]) expect(fieldKeepsControlChord(letter, true)).toBe(false);
    platform(original);
  });
});
