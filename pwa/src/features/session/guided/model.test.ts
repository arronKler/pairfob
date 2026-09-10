import { describe, expect, test } from "bun:test";
import { paneModelFromText, paneReadLinesFromViewport } from "./model";

describe("guided pane model", () => {
  test("parses ANSI text and reuses the model for the same buffer", () => {
    const first = paneModelFromText("hello");
    expect(first.texts).toEqual(["hello"]);
    const second = paneModelFromText("hello", { text: "hello", model: first });
    expect(second).toBe(first);
    const third = paneModelFromText("other", { text: "hello", model: first });
    expect(third).not.toBe(first);
    expect(third.texts).toEqual(["other"]);
  });

  test("clamps viewport rows to the daemon-safe read window", () => {
    expect(paneReadLinesFromViewport(undefined)).toBe(80);
    expect(paneReadLinesFromViewport(7)).toBe(80);
    expect(paneReadLinesFromViewport(24)).toBe(24);
    expect(paneReadLinesFromViewport(201)).toBe(80);
  });
});
