import { describe, expect, test } from "bun:test";
import { TERTIARY_KEYS } from "./keys";

describe("pad key tables", () => {
  test("the extra row is holdable modifiers plus readline chords Herdr accepts", () => {
    expect(TERTIARY_KEYS.filter((key) => key.modifier).map((key) => key.label)).toEqual(["Ctrl", "Opt", "Shift", "Cmd"]);
    expect(TERTIARY_KEYS.map((key) => key.key)).toContain("ctrl+a");
    expect(TERTIARY_KEYS.map((key) => key.key)).toContain("ctrl+e");
    expect(TERTIARY_KEYS.map((key) => key.key)).toContain("ctrl+k");
  });
});
