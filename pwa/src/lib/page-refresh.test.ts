import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../test-support/dom";
import { preparePageRefresh } from "./page-refresh";

const originalFetch = globalThis.fetch;
beforeEach(resetBoardTestDOM);
afterEach(() => { globalThis.fetch = originalFetch; });
const shell = '<script type="module" src="/assets/new.js"></script><link rel="stylesheet" href="/assets/new.css">';
const html = (body = shell) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

test("refresh primes a unique shell and its assets before returning the navigation URL", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  let releaseAsset!: () => void;
  const pendingAsset = new Promise<void>(resolve => { releaseAsset = resolve; });
  globalThis.fetch = (async (input, options) => {
    const url = String(input);
    calls.push({ url, options });
    if (new URL(url).pathname === "/pair") return html();
    await pendingAsset;
    return new Response("asset");
  }) as typeof fetch;
  const controller = new AbortController();
  let ready = false;
  const refresh = preparePageRefresh("https://pairfob.com/pair#old-pairing", controller.signal).then(url => { ready = true; return url; });
  for (let i = 0; i < 10 && calls.length < 3; i++) await Promise.resolve();
  expect(calls).toHaveLength(3);
  expect(ready).toBeFalse();
  releaseAsset();
  const target = new URL(await refresh);
  expect(target.origin).toBe("https://pairfob.com");
  expect(target.pathname).toBe("/pair");
  expect(target.hash).toBe("");
  expect(target.searchParams.get("_pairfob_refresh")).toBeTruthy();
  expect(calls[0].url).toBe(target.href);
  for (const call of calls) {
    expect(call.options?.cache).toBe("no-store");
    expect(call.options?.signal).toBe(controller.signal);
  }
  const second = await preparePageRefresh(target.href, controller.signal);
  expect(second).not.toBe(target.href);
  expect(new URL(second).searchParams.getAll("_pairfob_refresh")).toHaveLength(1);
});

test("the shipped worker serves the freshly primed shell when navigation exceeds its grace period", async () => {
  const origin = "https://pairfob.com";
  const cached = new Map<string, Response>([[origin + "/pair", html("old page")]]);
  const key = (request: Request | string) => typeof request === "string" ? new URL(request, origin).href : request.url;
  const cache = {
    match: async (request: Request | string) => cached.get(key(request))?.clone(),
    put: async (request: Request | string, response: Response) => { cached.set(key(request), response); },
    addAll: async () => undefined,
  };
  let handler!: (event: { request: Request; respondWith: (response: Promise<Response>) => void; waitUntil: (work: Promise<unknown>) => void }) => void;
  let slow = false;
  let finishNetwork!: (response: Response) => void;
  const upstream = async (request: Request) => {
    if (slow) return new Promise<Response>(resolve => { finishNetwork = resolve; });
    const response = new URL(request.url).pathname === "/pair" ? html() : new Response("asset");
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const source = await Bun.file(new URL("../../public/sw.js", import.meta.url)).text();
  new Function("self", "caches", "fetch", "setTimeout", "clearTimeout", source)(
    { location: { origin }, addEventListener: (name: string, callback: typeof handler) => { if (name === "fetch") handler = callback; } },
    { match: cache.match, open: async () => cache }, upstream,
    (callback: () => void) => { callback(); return 1; }, () => undefined,
  );
  const background: Promise<unknown>[] = [];
  const dispatch = (request: Request) => {
    let reply: Promise<Response> | undefined;
    handler({ request, respondWith: (response) => { reply = response; }, waitUntil: (work) => { background.push(work); } });
    return reply!;
  };
  globalThis.fetch = ((url, options) => dispatch(new Request(url, options))) as typeof fetch;
  const target = await preparePageRefresh(origin + "/pair", new AbortController().signal);
  expect(await cached.get(origin + "/pair")!.clone().text()).toBe("old page");
  slow = true;
  const navigation = new Request(target);
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  expect(await (await dispatch(navigation)).text()).toBe(shell);
  finishNetwork(html());
  await Promise.all(background);
});

test("offline, bad shells, failed assets and cancellation never produce a navigation target", async () => {
  for (const response of [
    () => Promise.reject(new Error("offline")),
    async () => new Response("error", { status: 503 }),
    async () => new Response(shell),
    async () => html("<h1>Not the app</h1>"),
    async (url: string) => new URL(url).pathname === "/pair" ? html() : new Response("missing", { status: 404 }),
  ]) {
    globalThis.fetch = response as typeof fetch;
    await expect(preparePageRefresh("https://pairfob.com/pair", new AbortController().signal)).rejects.toThrow();
  }
  globalThis.fetch = (async (url) => new URL(String(url)).pathname === "/pair" ? html() : new Response("asset")) as typeof fetch;
  const controller = new AbortController();
  controller.abort();
  await expect(preparePageRefresh("https://pairfob.com/pair", controller.signal)).rejects.toThrow("Refresh cancelled");
});
