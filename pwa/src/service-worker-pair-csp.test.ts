import { expect, test } from "bun:test";

const worker = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();
const origin = "https://pairfob.com";
const pairCSP = "worker-src 'self' blob:;";
const defaultCSP = "worker-src 'self';";

function harness(network: "offline" | "slow" | "404") {
  let handler: (event: unknown) => void;
  const scope = { location: { origin }, addEventListener: (name: string, fn: typeof handler) => { if (name === "fetch") handler = fn; } };
  const cache = new Map([
    ["/pair", new Response("pair", { headers: { "Content-Security-Policy": pairCSP } })],
    ["/", new Response("home", { headers: { "Content-Security-Policy": defaultCSP } })],
  ]);
  const match = async (key: string | Request) => cache.get(new URL(typeof key === "string" ? key : key.url, origin).pathname)?.clone();
  const caches = { match, open: async () => ({ match, put: async () => undefined }) };
  const fetch = async () => {
    if (network === "offline") throw new Error("offline");
    if (network === "slow") return new Promise<Response>(() => undefined);
    return new Response("not found", { status: 404 });
  };
  new Function("self", "caches", "fetch", "setTimeout", "clearTimeout", worker)(scope, caches, fetch, (callback: () => void) => { if (network === "slow") callback(); return 1; }, () => undefined);
  return (path: string) => {
    let response: Promise<Response> | undefined;
    handler!({ request: { url: origin + path, method: "GET", mode: "navigate" }, respondWith: (value: Promise<Response>) => { response = value; }, waitUntil: () => undefined });
    if (!response) throw new Error("navigation was not intercepted");
    return response;
  };
}

for (const network of ["offline", "slow", "404"] as const) {
  for (const path of ["/pair", "/pair/", "/pair.html", "/pair#invite", "/pair/?from=home"]) {
    test(network + " pairing alias keeps QR worker policy: " + path, async () => {
      const response = await harness(network)(path);
      expect(await response.text()).toBe("pair");
      expect(response.headers.get("Content-Security-Policy")).toBe(pairCSP);
    });
  }
  for (const path of ["/pair/workspace/root", "/pair-other", "/pair.html/extra", "/demo", "/"]) {
    test(network + " other navigation keeps default policy: " + path, async () => {
      const response = await harness(network)(path);
      expect(await response.text()).toBe("home");
      expect(response.headers.get("Content-Security-Policy")).toBe(defaultCSP);
    });
  }
}
