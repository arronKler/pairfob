import { describe, expect, test } from "bun:test";
import {
  DIRECT_HEALTH_PING_MS,
  DIRECT_ICE_GRACE_MS,
  DIRECT_RESTART_MIN_INTERVAL_MS,
  DIRECT_RESTART_TIMEOUT_MS,
  DIRECT_RETRY_MAX_MS,
  DIRECT_RETRY_STEPS_MS,
  directRetryDelay,
} from "./direct-retry-policy.ts";

describe("P2P retry backoff", () => {
  test("steps through 30 seconds, 2 minutes, 5 minutes, then caps at 10 minutes", () => {
    expect(DIRECT_RETRY_STEPS_MS).toEqual([30_000, 120_000, 300_000, 600_000]);
    expect(directRetryDelay(0, () => 0.5)).toBe(30_000);
    expect(directRetryDelay(1, () => 0.5)).toBe(120_000);
    expect(directRetryDelay(2, () => 0.5)).toBe(300_000);
    expect(directRetryDelay(3, () => 0.5)).toBe(600_000);
    expect(directRetryDelay(99, () => 1)).toBe(DIRECT_RETRY_MAX_MS);
  });

  test("clamps invalid attempts and random sources", () => {
    expect(directRetryDelay(-2, () => -5)).toBe(24_000);
    expect(directRetryDelay(0, () => 5)).toBe(36_000);
  });

  test("health-check constants stay short relative to the retry table", () => {
    expect(DIRECT_ICE_GRACE_MS).toBe(2_000);
    expect(DIRECT_HEALTH_PING_MS).toBe(3_000);
    expect(DIRECT_RESTART_MIN_INTERVAL_MS).toBe(15_000);
    expect(DIRECT_RESTART_TIMEOUT_MS).toBe(30_000);
    expect(DIRECT_RESTART_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(DIRECT_HEALTH_PING_MS).toBeLessThan(DIRECT_RETRY_STEPS_MS[0]);
  });
});
