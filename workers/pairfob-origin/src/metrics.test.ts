import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { observeEnroll, observeError, resetMetrics, sanitizeIndex, sanitizeLabel, snapshot } from "./metrics.ts";
import { FakeMetrics, testEnv } from "./testutil/make-room.ts";

beforeEach(() => resetMetrics());

describe("metrics labels", () => {
  test("keeps allowlisted ids and error codes", () => {
    expect(sanitizeLabel("unpaired")).toBe("unpaired");
    expect(sanitizeLabel("too_many_devices")).toBe("too_many_devices");
    expect(sanitizeIndex("d_" + "ab".repeat(10))).toBe("d_" + "ab".repeat(10));
    expect(sanitizeIndex("g_" + "aa".repeat(8))).toBe("g_" + "aa".repeat(8));
  });

  test("redacts grant and reconnect secrets instead of storing them as labels", () => {
    expect(sanitizeLabel("jg_" + "ab".repeat(16))).toBe("redacted");
    expect(sanitizeLabel("rt_" + "cd".repeat(16))).toBe("redacted");
    expect(sanitizeLabel("it_" + "ee".repeat(16))).toBe("redacted");
    expect(sanitizeLabel("pair_ticket")).toBe("redacted");
    expect(sanitizeLabel("reconnect_token")).toBe("redacted");
    expect(sanitizeLabel("join_grant")).toBe("redacted");
    expect(sanitizeLabel("https://pairfob.com/v2/ws?pair_ticket=aa")).toBe("redacted");
    expect(sanitizeIndex("jg_" + "ab".repeat(16))).toBe("");
  });

  test("writes enroll points without secret blobs", () => {
    const metrics = new FakeMetrics();
    const env = testEnv({ metrics });
    env.BUILD = "dev";
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      observeEnroll(env, "ok", "d_" + "ab".repeat(10));
      observeError(env, "rate_limited");
    } finally {
      console.log = orig;
    }
    expect(snapshot().enroll).toBe(1);
    expect(snapshot()["enroll.ok"]).toBe(1);
    expect(snapshot().error).toBe(1);
    expect(metrics.points[0]?.indexes).toEqual(["d_" + "ab".repeat(10)]);
    expect(metrics.points[0]?.blobs?.[0]).toBe("enroll");
    expect(metrics.points[0]?.blobs?.[1]).toBe("ok");
    const dumped = JSON.stringify(metrics.points) + logs.join("\n");
    expect(dumped).not.toContain("jg_");
    expect(dumped).not.toContain("rt_");
    expect(dumped).not.toContain("pair_ticket");
    expect(dumped).not.toContain("req.url");
    expect(logs.some((line) => line.includes('"event":"enroll"'))).toBe(true);
  });

  test("source does not log request URLs", () => {
    const src = readFileSync(new URL("./metrics.ts", import.meta.url), "utf8")
      + readFileSync(new URL("./events.ts", import.meta.url), "utf8");
    expect(src).not.toContain("req.url");
    expect(src).not.toContain("searchParams");
    expect(src).not.toMatch(/console\.log\([^)]*url/i);
  });
});
