import { beforeEach, describe, expect, test } from "bun:test";
import { allow, bucketCount, MAX_BUCKETS, resetLimits } from "./limits.ts";

beforeEach(() => resetLimits());

describe("rate limit buckets", () => {
  test("denies past the limit and recovers when the window slides", () => {
    expect(allow("ip", 2, 1_000, 0)).toBe(true);
    expect(allow("ip", 2, 1_000, 100)).toBe(true);
    expect(allow("ip", 2, 1_000, 200)).toBe(false);
    expect(allow("ip", 2, 1_000, 1_100)).toBe(true);
  });

  test("drops keys that have been quiet for a full window", () => {
    allow("quiet", 5, 60_000, 0);
    expect(bucketCount()).toBe(1);
    allow("live", 5, 60_000, 120_000);
    expect(bucketCount()).toBe(1);
  });

  test("caps the bucket map under a flood of distinct addresses", () => {
    for (let i = 0; i <= MAX_BUCKETS + 100; i += 1) allow(`ip-${i}`, 5, 60_000, 0);
    expect(bucketCount()).toBe(MAX_BUCKETS);
  });
});
