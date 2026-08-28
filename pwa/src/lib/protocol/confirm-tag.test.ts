import { describe, expect, test } from "bun:test";
import { confirmationTagMatches } from "./client.ts";

describe("ConfirmPairing tag gate", () => {
  test("acks only when the frozen confirmation tag matches", () => {
    expect(confirmationTagMatches("walnut-cinder", "walnut-cinder")).toBe(true);
    expect(confirmationTagMatches("walnut-cinder", "other-word")).toBe(false);
    expect(confirmationTagMatches("", "")).toBe(false);
    expect(confirmationTagMatches("", "walnut-cinder")).toBe(false);
    expect(confirmationTagMatches("walnut-cinder", null)).toBe(false);
  });
});
