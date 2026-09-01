import { beforeEach, describe, expect, test } from "bun:test";
import { handleEvents, pageClass } from "./events.ts";
import { resetLimits } from "./limits.ts";
import { resetMetrics, snapshot } from "./metrics.ts";
import { FakeMetrics, testEnv } from "./testutil/make-room.ts";
import { handleFetch } from "./worker.ts";

beforeEach(() => {
  resetLimits();
  resetMetrics();
});

function beacon(events: unknown, extra?: HeadersInit): Request {
  return new Request("https://pairfob.com/v2/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://pairfob.com", "CF-Connecting-IP": "198.51.100.9", ...extra },
    body: JSON.stringify({ v: 2, events }),
  });
}

describe("page classification", () => {
  test("maps public documents and ignores assets", () => {
    expect(pageClass("/")).toBe("home");
    expect(pageClass("/zh")).toBe("home_zh");
    expect(pageClass("/pair")).toBe("pair");
    expect(pageClass("/doc/start")).toBe("docs");
    expect(pageClass("/install.sh")).toBe("install");
    expect(pageClass("/dl/pairfob-linux-arm64")).toBe("download");
    expect(pageClass("/assets/index.js")).toBeNull();
  });
});

describe("POST /v2/events", () => {
  test("accepts allowlisted PWA events and drops spoofed mux names", async () => {
    const metrics = new FakeMetrics();
    const env = testEnv({ metrics });
    const ok = await handleEvents(
      beacon([
        { name: "pwa_boot", result: "ok", extra: "connect" },
        { name: "pwa_agent_trace", result: "content", extra: "lt_100ms" },
        { name: "pwa_p2p", result: "failed", extra: "ice_timeout" },
        { name: "enroll", result: "ok" },
      ]),
      env,
    );
    expect(ok.status).toBe(200);
    expect(snapshot().pwa_boot).toBe(1);
    expect(snapshot().pwa_agent_trace).toBe(1);
    expect(snapshot().pwa_p2p).toBe(1);
    expect(snapshot().enroll).toBeUndefined();
    expect(metrics.points.some((p) => p.blobs?.[0] === "pwa_boot")).toBe(true);
    expect(metrics.points.some((p) => p.blobs?.[0] === "pwa_p2p" && p.blobs?.[3] === "ice_timeout")).toBe(true);
    expect(metrics.points.some((p) => p.blobs?.[0] === "enroll")).toBe(false);
  });

  test("strips secret-shaped fields and rejects missing origin or unknown names", async () => {
    const metrics = new FakeMetrics();
    const env = testEnv({ metrics });
    const secret = await handleEvents(beacon([{ name: "pwa_boot", result: "jg_" + "aa".repeat(16) }]), env);
    expect(secret.status).toBe(200);
    expect(JSON.stringify(metrics.points)).not.toContain("jg_");
    expect(metrics.points[0]?.blobs?.[1]).toBe("");
    const unknown = await handleEvents(beacon([{ name: "enroll", result: "ok" }]), env);
    expect(unknown.status).toBe(400);
    const foreign = await handleEvents(beacon([{ name: "pwa_boot" }], { Origin: "https://evil.example" }), env);
    expect(foreign.status).toBe(403);
    const emptyOrigin = await handleEvents(
      new Request("https://pairfob.com/v2/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 2, events: [{ name: "pwa_boot" }] }),
      }),
      env,
    );
    expect(emptyOrigin.status).toBe(403);
  });

  test("rate-limits beacons per IP", async () => {
    const env = testEnv();
    for (let i = 0; i < 60; i++) {
      expect((await handleEvents(beacon([{ name: "pwa_live" }]), env)).status).toBe(200);
    }
    const limited = await handleEvents(beacon([{ name: "pwa_live" }]), env);
    expect(limited.status).toBe(429);
  });
});

describe("document pageviews", () => {
  test("GET /pair records a pair page event", async () => {
    const metrics = new FakeMetrics();
    const env = testEnv({
      metrics,
      assets: {
        fetch: async () => new Response("<main id=\"app\"></main>", { headers: { "Content-Type": "text/html" } }),
      },
    });
    const res = await handleFetch(new Request("https://pairfob.com/pair"), env);
    expect(res.status).toBe(200);
    expect(snapshot().page).toBe(1);
    expect(snapshot()["page.pair"]).toBe(1);
    expect(metrics.points.some((p) => p.blobs?.[0] === "page" && p.blobs?.[2] === "pair")).toBe(true);
  });
});
