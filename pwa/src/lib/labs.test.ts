import { describe, expect, test } from "bun:test";
import { labEnabled } from "./labs";

describe("URL-only labs gate", () => {
  test("enables only an explicitly named lab", () => {
    expect(labEnabled("workspace", "?labs=workspace")).toBeTrue();
    expect(labEnabled("workspace", "?labs=other,workspace")).toBeTrue();
    expect(labEnabled("workspace", "?labs=other")).toBeFalse();
    expect(labEnabled("workspace", "?workspace=1")).toBeFalse();
    expect(labEnabled("workspace", "")).toBeFalse();
  });
});
