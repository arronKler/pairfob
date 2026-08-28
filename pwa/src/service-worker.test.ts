import { describe, expect, test } from "bun:test";

const worker = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();

type URLSanitizer = (value: unknown) => string;
type ShellStrategy = (
  event: { waitUntil: (promise: Promise<unknown>) => void },
  request: Request,
  fallback: string,
) => Promise<Response>;

function loadURLSanitizer(): URLSanitizer {
  const scope = {
    location: { origin: "https://pairfob.com" },
    addEventListener: () => undefined,
  };
  return new Function("self", `${worker}\nreturn safeNotificationURL;`)(scope) as URLSanitizer;
}

function loadShellStrategy(options: {
  cached: Response;
  fetchImpl: () => Promise<Response>;
  setTimer?: (callback: () => void) => number;
}): ShellStrategy {
  const scope = { location: { origin: "https://pairfob.com" }, addEventListener: () => undefined };
  const caches = {
    match: async () => options.cached,
    open: async () => ({ addAll: async () => undefined, put: async () => undefined, match: async () => options.cached }),
    keys: async () => [],
    delete: async () => true,
  };
  const setTimer = options.setTimer || (() => 1);
  return new Function(
    "self",
    "caches",
    "fetch",
    "setTimeout",
    "clearTimeout",
    `${worker}\nreturn shellNetworkFirst;`,
  )(scope, caches, options.fetchImpl, setTimer, () => undefined) as ShellStrategy;
}

describe("notification service worker", () => {
  test("shows a notification and revalidates its same-origin deep link on click", () => {
    expect(worker).toContain('self.addEventListener("push"');
    expect(worker).toContain('self.addEventListener("notificationclick"');
    expect(worker).toContain("url.origin !== self.location.origin");
    expect(worker).toContain('url.pathname !== "/pair"');
    expect(worker).toContain("safeNotificationURL(event.notification.data?.url)");
  });

  test("serves the repeat-load shell immediately and caches immutable assets first", () => {
    expect(worker).toContain('const CACHE = "pairfob-shell-v7"');
    expect(worker).toContain("precacheShell()");
    expect(worker).toContain("shellAssetPaths(html)");
    expect(worker).toContain('request.mode === "navigate"');
    expect(worker).toContain("shellNetworkFirst(event, request, fallback)");
    expect(worker).toContain("SHELL_NETWORK_GRACE_MS = 750");
    expect(worker).toContain('url.pathname.startsWith("/assets/")');
    expect(worker).toContain("cacheFirst(request)");
    expect(worker).toContain("cacheShellResponse(request, response)");
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).toContain('url.pathname === "/doc" || url.pathname.startsWith("/doc/")');
  });

  test("uses a fresh shell on a healthy network", async () => {
    const strategy = loadShellStrategy({
      cached: new Response("cached"),
      fetchImpl: async () => new Response("fresh"),
    });
    const response = await strategy({ waitUntil: () => undefined }, new Request("https://pairfob.com/pair"), "/pair");
    expect(await response.text()).toBe("fresh");
  });

  test("falls back to the cached shell after the mobile grace period", async () => {
    let backgrounded = false;
    const strategy = loadShellStrategy({
      cached: new Response("cached"),
      fetchImpl: () => new Promise<Response>(() => undefined),
      setTimer: (callback) => { callback(); return 1; },
    });
    const response = await strategy({ waitUntil: () => { backgrounded = true; } }, new Request("https://pairfob.com/pair"), "/pair");
    expect(await response.text()).toBe("cached");
    expect(backgrounded).toBeTrue();
  });

  test("keeps the working cache when shell revalidation returns an error", async () => {
    const strategy = loadShellStrategy({
      cached: new Response("cached"),
      fetchImpl: async () => new Response("temporary failure", { status: 503 }),
    });
    const response = await strategy({ waitUntil: () => undefined }, new Request("https://pairfob.com/pair"), "/pair");
    expect(await response.text()).toBe("cached");
  });

  test("accepts only the exact private fragment target", () => {
    const sanitize = loadURLSanitizer();
    const valid = "/pair#d=d_0123456789abcdefabcd&notify=1&pane=w0%3Ap1";
    expect(sanitize(valid)).toBe(valid);
    expect(sanitize("https://evil.example/pair#d=d_0123456789abcdefabcd&notify=1&pane=w0:p1")).toBe("/pair");
    expect(sanitize("/other#d=d_0123456789abcdefabcd&notify=1&pane=w0:p1")).toBe("/pair");
    expect(sanitize("/pair?next=/other#d=d_0123456789abcdefabcd&notify=1&pane=w0:p1")).toBe("/pair");
    expect(sanitize("/pair#d=d_0123456789abcdefabcd&notify=1&notify=1&pane=w0:p1")).toBe("/pair");
    expect(sanitize("/pair#d=d_0123456789abcdefabcd&notify=1&pane=/private/path")).toBe("/pair");
  });
});
