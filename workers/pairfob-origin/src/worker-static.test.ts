import { describe, expect, test } from "bun:test";
import { handleFetch } from "./worker.ts";
import { testEnv } from "./testutil/make-room.ts";

function assets(files: Record<string, string>, normalizeHTML = false): Fetcher {
  return {
    fetch(input: RequestInfo | URL) {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const path = new URL(url, "https://pairfob.com").pathname;
      if (normalizeHTML && path.endsWith("/index.html")) {
        return Promise.resolve(Response.redirect("https://pairfob.com" + path.slice(0, -"/index.html".length), 307));
      }
      // Cloudflare's asset binding resolves a directory to its index.html.
      const body = files[path] ?? (path.endsWith("/") ? files[path + "index.html"] : undefined);
      if (body === undefined) return Promise.resolve(new Response("missing", { status: 404 }));
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    },
  };
}

describe("worker static overlay", () => {
  test("GET /pair bypasses HTML normalization and serves the opaque PWA shell", async () => {
    const env = testEnv({
      assets: assets({
        "/index.html": "<h1>marketing</h1>",
        "/pair-shell.asset": "<main id=\"app\"></main>",
      }, true),
    });
    for (const path of ["/pair", "/pair/", "/pair.html"]) {
      const res = await handleFetch(new Request("https://pairfob.com" + path), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(res.headers.get("Cache-Control")).toBe("no-store, no-transform");
      expect(await res.text()).toContain('id="app"');
    }
  });

  test("GET /zh serves the same marketing document as /", async () => {
    const env = testEnv({
      assets: assets({
        "/index.html": "<html lang=\"en\"><h1>Agents that run on your computer</h1></html>",
        "/zh-shell.asset": "<html lang=\"en\"><h1>Agents that run on your computer</h1></html>",
      }, true),
    });
    for (const path of ["/zh", "/zh/", "/zh/index.html"]) {
      const res = await handleFetch(new Request("https://pairfob.com" + path), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Agents that run on your computer");
    }
  });

  test("the retired /en URLs redirect instead of 404ing", async () => {
    const env = testEnv({ assets: assets({ "/index.html": "<html></html>" }) });
    const cases: [string, string][] = [
      ["/en", "/"],
      ["/en/", "/"],
      ["/en/index.html", "/"],
      ["/doc/en", "/doc/"],
      ["/doc/en/", "/doc/"],
      ["/doc/en/start", "/doc/start"],
    ];
    for (const [from, to] of cases) {
      const res = await handleFetch(new Request("https://pairfob.com" + from), env);
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe(to);
    }
  });

  test("GET /doc/ follows the Assets trailing-slash redirect", async () => {
    const env = testEnv({
      assets: {
        fetch(input: RequestInfo | URL) {
          const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
          const path = new URL(url, "https://pairfob.com").pathname;
          if (path === "/doc/" || path === "/doc/zh/") {
            return Promise.resolve(Response.redirect("https://pairfob.com" + path.slice(0, -1), 307));
          }
          if (path === "/doc" || path === "/doc/zh") {
            return Promise.resolve(
              new Response("<!doctype html><title>docs</title>", {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }),
            );
          }
          return Promise.resolve(new Response("missing", { status: 404 }));
        },
      },
    });
    for (const path of ["/doc/", "/doc/zh/"]) {
      const res = await handleFetch(new Request("https://pairfob.com" + path), env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Location")).toBeNull();
      expect(await res.text()).toContain("<title>docs</title>");
      expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
      expect(res.headers.get("Content-Security-Policy")).not.toContain("wasm-unsafe-eval");
      expect(res.headers.get("Cache-Control")).toContain("no-transform");
    }
  });

  test("GET /install.sh is text/plain", async () => {
    const env = testEnv({
      assets: assets({
        "/install.sh": "#!/bin/sh\necho pairfob\n",
      }),
    });
    const res = await handleFetch(new Request("https://pairfob.com/install.sh"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toContain("pairfob");
  });

  test("retired /v2/grants does not mint a join grant", async () => {
    const res = await handleFetch(
      new Request("https://pairfob.com/v2/grants", {
        method: "POST",
        headers: { Origin: "https://pairfob.com" },
      }),
      testEnv(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: { code: "unbound" } });
  });
});
