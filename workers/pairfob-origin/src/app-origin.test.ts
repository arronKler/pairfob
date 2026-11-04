import { beforeEach, describe, expect, test } from "bun:test";
import { FakeD1 } from "./testutil/fake-d1.ts";
import { FakeRoomNamespace } from "./testutil/fake-ns.ts";
import { makeRoom, testEnv } from "./testutil/make-room.ts";
import { resetLimits } from "./limits.ts";
import { handleFetch } from "./worker.ts";

beforeEach(() => resetLimits());

const DAEMON_ID = "d_" + "ab".repeat(10);

function seededEnv(extra?: Parameters<typeof testEnv>[0]) {
  const d1 = new FakeD1();
  d1.daemons.set(DAEMON_ID, {
    daemon_id: DAEMON_ID,
    grant_id: "g_" + "ab".repeat(8),
    created_at: 1,
    kicked_at: null,
    enroll_ip_hash: null,
    quota_released_at: null,
  });
  const rooms = new FakeRoomNamespace((name) => makeRoom(name));
  return testEnv({ ...extra, d1, rooms });
}

function wsRequest(role: "client" | "daemon", origin?: string): Request {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": "pairfob.v2",
  };
  if (origin !== undefined) headers.Origin = origin;
  return new Request(`https://pairfob.com/v2/ws?role=${role}&daemon_id=${DAEMON_ID}`, { headers });
}

function pairIntent(origin: string): Request {
  return new Request("https://pairfob.com/v2/pair-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": "198.51.100.31" },
    body: JSON.stringify({ v: 2, pair_loc: "WJ3K9M" }),
  });
}

function events(origin: string): Request {
  return new Request("https://pairfob.com/v2/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": "198.51.100.32" },
    body: JSON.stringify({ v: 2, events: [{ name: "pwa_boot", result: "ok" }] }),
  });
}

function staticAssets(files: Record<string, string>): Fetcher {
  return {
    fetch(input: RequestInfo | URL) {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const path = new URL(url, "https://pairfob.com").pathname;
      const body = files[path];
      return Promise.resolve(body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    },
  };
}

describe("app origins", () => {
  test("the native https://localhost origin upgrades the client WebSocket", async () => {
    const env = seededEnv();
    const res = await handleFetch(wsRequest("client", "https://localhost"), env);
    expect(res.status).toBe(101);
  });

  test("client WebSocket accepts a native client with no Origin", async () => {
    const env = seededEnv();
    expect((await handleFetch(wsRequest("client", undefined), env)).status).toBe(101);
  });

  test("client WebSocket rejects an empty, null, foreign, non-exact, or dev-http Origin", async () => {
    const env = seededEnv();
    for (const origin of ["", "null", "https://evil.example", "https://localhost:4321", "http://localhost"]) {
      const res = await handleFetch(wsRequest("client", origin), env);
      expect(res.status).toBe(403);
    }
  });

  test("a dev worker may allow http://localhost explicitly", async () => {
    const env = seededEnv();
    env.ALLOW_HTTP_APP_ORIGINS = "1";
    const res = await handleFetch(wsRequest("client", "http://localhost"), env);
    expect(res.status).toBe(101);
  });

  test("the daemon WebSocket path still requires same-host or absent Origin", async () => {
    const env = seededEnv();
    expect((await handleFetch(wsRequest("daemon", "https://localhost"), env)).status).toBe(403);
    expect((await handleFetch(wsRequest("daemon", "https://pairfob.com"), env)).status).toBe(101);
  });

  test("pair-intent accepts the app origin and returns credentialed CORS headers", async () => {
    const env = seededEnv();
    const res = await handleFetch(pairIntent("https://localhost"), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  test("pair-intent keeps foreign origins out", async () => {
    const env = seededEnv();
    for (const origin of ["https://evil.example", "https://localhost:4321", "http://localhost"]) {
      const res = await handleFetch(pairIntent(origin), env);
      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  test("events accept the app origin and keep foreign origins out", async () => {
    const env = seededEnv();
    const accepted = await handleFetch(events("https://localhost"), env);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
    expect(accepted.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const foreign = await handleFetch(events("https://evil.example"), env);
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(foreign.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("/api/config is readable cross-origin only by an exact app origin", async () => {
    const env = seededEnv();
    const allowed = await handleFetch(new Request("https://pairfob.com/api/config", {
      headers: { Origin: "https://localhost" },
    }), env);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const foreign = await handleFetch(new Request("https://pairfob.com/api/config", {
      headers: { Origin: "https://evil.example" },
    }), env);
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(foreign.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("/dl/VERSION carries CORS for the app origin without changing the body", async () => {
    const env = seededEnv({ assets: staticAssets({ "/dl/VERSION": "2.3.4\n" }) });
    const res = await handleFetch(new Request("https://pairfob.com/dl/VERSION", {
      headers: { Origin: "https://localhost" },
    }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(await res.text()).toBe("2.3.4\n");
  });

  test("the Android beta manifest is readable from the app origin and never cached", async () => {
    const body = JSON.stringify({ channel: "beta", versionCode: 5 });
    const env = seededEnv({ assets: staticAssets({ "/dl/android/beta/latest.json": body }) });
    const res = await handleFetch(new Request("https://pairfob.com/dl/android/beta/latest.json", {
      headers: { Origin: "https://localhost" },
    }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe(body);

    const publicRead = await handleFetch(new Request("https://pairfob.com/dl/android/beta/latest.json"), env);
    expect(publicRead.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("the Android beta APK is an immutable installable download", async () => {
    const env = seededEnv({ assets: staticAssets({ "/dl/android/beta/pairfob-1.0.0-beta.5.apk": "apk" }) });
    const res = await handleFetch(new Request("https://pairfob.com/dl/android/beta/pairfob-1.0.0-beta.5.apk"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  test("the Android beta manifest answers the app preflight", async () => {
    const env = seededEnv();
    const res = await handleFetch(new Request("https://pairfob.com/dl/android/beta/latest.json", {
      method: "OPTIONS",
      headers: { Origin: "https://localhost", "Access-Control-Request-Method": "GET" },
    }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
  });

  test("preflight answers the app origin with methods, content-type, and credentials", async () => {
    const env = seededEnv();
    const res = await handleFetch(new Request("https://pairfob.com/v2/pair-intent", {
      method: "OPTIONS",
      headers: {
        Origin: "https://localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("content-type");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  test("preflight reflects the cache headers a no-store fetch sends", async () => {
    const env = seededEnv();
    const res = await handleFetch(new Request("https://pairfob.com/dl/android/beta/latest.json", {
      method: "OPTIONS",
      headers: {
        Origin: "https://localhost",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "cache-control, pragma",
      },
    }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("cache-control, pragma");
  });

  test("preflight leaves a foreign or arbitrary localhost port without CORS", async () => {
    const env = seededEnv();
    for (const origin of ["https://evil.example", "https://localhost:4321"]) {
      const res = await handleFetch(new Request("https://pairfob.com/v2/events", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
      }), env);
      expect(res.status).toBe(405);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  test("same-host OPTIONS keeps its previous non-CORS behavior", async () => {
    const env = seededEnv();
    const res = await handleFetch(new Request("https://pairfob.com/v2/events", {
      method: "OPTIONS",
      headers: { Origin: "https://pairfob.com" },
    }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
