import { describe, expect, test } from "bun:test";
import { handleFetch } from "./worker.ts";
import { testEnv } from "./testutil/make-room.ts";

const REMOTE_CHALLENGE = "https://challenges.cloudflare.com";

function assets(): Fetcher {
  return {
    fetch: async () => new Response("<!doctype html><title>x</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  } as unknown as Fetcher;
}

async function cspOf(path: string): Promise<string> {
  const res = await handleFetch(new Request("https://pairfob.com" + path), testEnv({ assets: assets() }));
  return res.headers.get("Content-Security-Policy") ?? "";
}

describe("static content security policy", () => {
  test("the landing document keeps a strict self-only script policy", async () => {
    for (const path of ["/", "/index.html", "/zh", "/zh/", "/zh/index.html"]) {
      const csp = await cspOf(path);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain(REMOTE_CHALLENGE);
      expect(csp).not.toContain("frame-src");
      expect(csp).not.toContain("wasm-unsafe-eval");
    }
  });

  test("the PWA and its assets keep the default-deny CSP", async () => {
    for (const path of ["/pair", "/pair/", "/pair.html", "/assets/index.js", "/sw.js"]) {
      const csp = await cspOf(path);
      expect(csp).not.toContain(REMOTE_CHALLENGE);
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("default-src 'self'");
    }
  });

  test("docs use the same no-Wasm script policy as the landing page", async () => {
    for (const path of ["/doc", "/doc/", "/doc/start", "/doc/zh"]) {
      const csp = await cspOf(path);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("wasm-unsafe-eval");
    }
  });

  test("static HTML is framed-off and tagged with the build", async () => {
    for (const path of ["/", "/pair", "/doc"]) {
      const res = await handleFetch(new Request("https://pairfob.com" + path), testEnv({ assets: assets() }));
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("X-Pairfob-Build")).toBeTruthy();
      expect(res.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
      expect(res.headers.get("Cache-Control")).toContain("no-transform");
    }
  });

  test("JSON routes never widen the policy", async () => {
    for (const path of ["/api/config", "/v2/health", "/v2/grants", "/v2/events"]) {
      expect(await cspOf(path)).not.toContain(REMOTE_CHALLENGE);
    }
  });
});
