import { describe, expect, test } from "bun:test";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelay } from "./reconnect-policy.ts";

describe("mobile reconnect backoff", () => {
  test("uses bounded jitter around exponential backoff", () => {
    expect(reconnectDelay(0, () => 0)).toBe(Math.round(RECONNECT_BASE_MS * 0.8));
    expect(reconnectDelay(0, () => 1)).toBe(Math.round(RECONNECT_BASE_MS * 1.2));
    expect(reconnectDelay(3, () => 0.5)).toBe(RECONNECT_BASE_MS * 8);
    expect(reconnectDelay(99, () => 1)).toBe(RECONNECT_MAX_MS);
  });

  test("clamps bad random sources and negative attempts", () => {
    expect(reconnectDelay(-3, () => -10)).toBe(Math.round(RECONNECT_BASE_MS * 0.8));
    expect(reconnectDelay(0, () => 10)).toBe(Math.round(RECONNECT_BASE_MS * 1.2));
  });
});
