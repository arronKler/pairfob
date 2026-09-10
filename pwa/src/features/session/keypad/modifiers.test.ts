import { describe, expect, test } from "bun:test";
import { mapPadKey } from "./modifiers";

const none = { ctrl: false, alt: false, shift: false, cmd: false };

describe("pad key remap", () => {
  test("Ctrl or Cmd turns a letter into ctrl+letter and drops illegal chords", () => {
    expect(mapPadKey("c", { ...none, ctrl: true })).toEqual(["ctrl+c"]);
    expect(mapPadKey("ctrl+a", { ...none, ctrl: true })).toEqual(["ctrl+a"]);
    expect(mapPadKey("k", { ...none, cmd: true })).toEqual(["ctrl+k"]);
    expect(mapPadKey("up", { ...none, ctrl: true })).toEqual([]);
  });

  test("Opt maps onto esc+letter / readline word kills, Shift uppercases", () => {
    expect(mapPadKey("left", { ...none, alt: true })).toEqual(["esc", "b"]);
    expect(mapPadKey("right", { ...none, alt: true })).toEqual(["esc", "f"]);
    expect(mapPadKey("backspace", { ...none, alt: true })).toEqual(["ctrl+w"]);
    expect(mapPadKey("a", { ...none, shift: true })).toEqual(["A"]);
  });

  test("with no modifiers the token is unchanged", () => {
    expect(mapPadKey("enter", none)).toEqual(["enter"]);
  });
});
