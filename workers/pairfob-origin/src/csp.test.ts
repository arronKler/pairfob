import { describe, expect, test } from "bun:test";
import { handleFetch } from "./worker.ts";
import { testEnv } from "./testutil/make-room.ts";

const REMOTE_CHALLENGE = "https://challenges.cloudflare.com";

// The two approved xterm style insertions (native xterm-csp-review-0432):
// the empty Viewport style element and the exact 267-byte scrollbar slider CSS.
const XTERM_STYLE = [
  "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
  "'sha256-JVKkopR5uGguAsHA+8LKNHePLgO6ntgrlxTcOIvoM4w='",
] as const;

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
  test("the landing document keeps a strict self-only script policy and no blob/hash media", async () => {
    for (const path of ["/", "/index.html", "/zh", "/zh/", "/zh/index.html"]) {
      const csp = await cspOf(path);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain(REMOTE_CHALLENGE);
      expect(csp).not.toContain("frame-src");
      expect(csp).not.toContain("wasm-unsafe-eval");
      // Marketing is unchanged: no blob object-URL media and no xterm hashes.
      expect(csp).not.toContain("blob:");
      expect(csp).not.toContain("media-src");
      expect(csp).not.toContain("sha256-");
    }
  });

  test("the PWA and its assets keep the default-deny CSP plus blob media and the two xterm style hashes", async () => {
    for (const path of ["/pair", "/pair/", "/pair.html", "/pair/workspace/root", "/assets/index.js", "/sw.js"]) {
      const csp = await cspOf(path);
      expect(csp).not.toContain(REMOTE_CHALLENGE);
      expect(csp).toContain("default-src 'self'");
      // Real workspace image/audio/video object URLs render under the PWA only.
      expect(csp).toContain("img-src 'self' data: blob:");
      expect(csp).toContain("media-src blob:");
      // The media widening is the ONLY network/media relaxation on the PWA policy.
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain("connect-src 'self' blob:");
      expect(csp).not.toContain("*");
      expect(csp).toContain("object-src 'none'");
      // Script stays exactly the app policy: the standalone inline-eval token is
      // absent while the legitimately approved wasm-unsafe-eval remains.
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-hashes'");
      // style-src is the exact approved xterm surface: self + Google Fonts + the
      // two hashes, and nothing else hash-shaped.
      expect(csp).toContain("style-src 'self' https://fonts.googleapis.com");
      for (const hash of XTERM_STYLE) expect(csp).toContain(hash);
      expect(csp.match(/sha256-/g) ?? []).toHaveLength(2);
    }
  });

  test("docs use the same no-Wasm script policy as the landing page and no blob/hash media", async () => {
    for (const path of ["/doc", "/doc/", "/doc/start", "/doc/zh"]) {
      const csp = await cspOf(path);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("wasm-unsafe-eval");
      expect(csp).not.toContain("blob:");
      expect(csp).not.toContain("media-src");
      expect(csp).not.toContain("sha256-");
    }
  });

  test("static HTML is framed-off and tagged with the build", async () => {
    for (const path of ["/", "/pair", "/doc"]) {
      const res = await handleFetch(new Request("https://pairfob.com" + path), testEnv({ assets: assets() }));
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("X-Pairfob-Build")).toBeTruthy();
      expect(res.headers.get("Content-Security-Policy")).not.toContain("'unsafe-inline'");
      expect(res.headers.get("Cache-Control")).toContain("no-transform");
    }
  });

  test("blob object-URL media is served only on the pair document, never on marketing or docs", async () => {
    const provided = await cspOf("/pair/workspace/root/deep");
    expect(provided).toContain("img-src 'self' data: blob:");
    expect(provided).toContain("media-src blob:");
    for (const path of ["/", "/zh", "/doc", "/doc/start"]) {
      const csp = await cspOf(path);
      expect(csp).not.toContain("blob:");
      expect(csp).not.toContain("media-src");
      expect(csp).toContain("script-src 'self'");
    }
  });

  test("JSON routes never widen the policy", async () => {
    for (const path of ["/api/config", "/v2/health", "/v2/enroll", "/v2/events"]) {
      expect(await cspOf(path)).not.toContain(REMOTE_CHALLENGE);
    }
  });
});