import { expect, test } from "bun:test";

const worker = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();
const origin = "https://pairfob.com";
const target = `${origin}/pair#notify=1&d=d_aaaaaaaaaaaaaaaaaaaa&pane=w1%3Ap1`;

type Client = {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(data: unknown, ports: MessagePort[]): void;
};

type Storage = { body?: string; blocked?: boolean };
function harness(mode: "current" | "old" | "closed" | "no-client" | "homepage" | "focus-rejected", storage: Storage = {}) {
  const calls: string[] = [];
  const client: Client = {
    url: mode === "homepage" ? `${origin}/` : `${origin}/pair`,
    focus: async () => {
      calls.push("focus");
      if (mode === "focus-rejected") throw new Error("private browser error");
      return client;
    },
    navigate: async url => { calls.push(`navigate:${url}`); return mode === "closed" ? null : client; },
    postMessage(data, ports) {
      expect(data).toEqual({ type: "pairfob_notify", url: target });
      calls.push("message");
      if (mode === "current" || mode === "focus-rejected") ports[0]!.postMessage({ type: "pairfob_notify_captured" });
    },
  };
  let click!: (event: unknown) => void;
  let activate!: (event: unknown) => void;
  const scope = {
    location: { origin },
    addEventListener: (name: string, handler: typeof click) => {
      if (name === "notificationclick") click = handler;
      if (name === "activate") activate = handler;
    },
    clients: {
      matchAll: async () => mode === "no-client" ? [] : [client],
      openWindow: async (url: string) => { calls.push(`open:${url}`); return client; },
      claim: async () => {},
    },
  };
  const cacheStorage = {
    open: async () => {
      if (storage.blocked) throw new Error("storage unavailable");
      return {
        match: async () => storage.body ? new Response(storage.body) : undefined,
        put: async (_key: string, response: Response) => { storage.body = await response.text(); },
      };
    },
    keys: async () => ["pairfob-shell-v9", "pairfob-notification-diagnostics-v1"],
    delete: async (key: string) => { if (key === "pairfob-notification-diagnostics-v1") delete storage.body; },
  };
  new Function("self", "setTimeout", "caches", worker)(scope, (callback: () => void) => setTimeout(callback, 30), cacheStorage);
  return {
    calls,
    evidence: (): Array<{ event: string; reason?: string }> => JSON.parse(storage.body || "[]"),
    async activate() {
      let pending!: Promise<unknown>;
      activate({ waitUntil: (work: Promise<unknown>) => { pending = work; } });
      await pending;
    },
    async tap() {
      let pending!: Promise<unknown>;
      click({ notification: { data: { url: target }, close: () => calls.push("close") },
        waitUntil: (work: Promise<unknown>) => { pending = work; } });
      await pending;
    },
  };
}

test("a running client captures the click and focuses without navigation", async () => {
  const h = harness("current");
  await h.tap();
  expect(h.calls).toEqual(["close", "message", "focus"]);
});

test("a page predating the message receiver falls back to its deep-link URL", async () => {
  const h = harness("old");
  await h.tap();
  expect(h.calls).toEqual(["close", "message", "focus", `navigate:${target}`]);
});

for (const mode of ["no-client", "homepage"] as const) test(`${mode}: open the app with the cold-start target`, async () => {
  const h = harness(mode);
  await h.tap();
  expect(h.calls).toEqual(["close", `open:${target}`]);
});

test("a client closing during delivery falls back to opening a window", async () => {
  const h = harness("closed");
  await h.tap();
  expect(h.calls.at(-1)).toBe(`open:${target}`);
});

test("worker evidence distinguishes capture from focus and navigation fallback", async () => {
  const current = harness("current");
  await current.tap();
  expect(current.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_ack", reason: "captured" }));
  expect(current.evidence().some(row => row.event === "notify_sw_navigate")).toBe(false);
  const old = harness("old");
  await old.tap();
  expect(old.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_ack", reason: "timeout" }));
  expect(old.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_navigate", reason: "ok" }));
});

test("focus rejection still records capture and the separate openWindow outcome", async () => {
  const h = harness("focus-rejected");
  await h.tap();
  expect(h.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_client_error" }));
  expect(h.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_ack", reason: "captured" }));
  expect(h.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_open", reason: "ok" }));
  expect(JSON.stringify(h.evidence())).not.toMatch(/private|https:|w1|d_aaaa/);
});

test("worker restart and activation preserve bounded recent evidence", async () => {
  const storage = { body: JSON.stringify([
    { at: Date.now() - 25 * 3600000, event: "notify_sw_click" },
    ...Array.from({ length: 105 }, () => ({ at: Date.now(), event: "notify_sw_shown" })),
  ]) };
  const first = harness("current", storage);
  await first.tap();
  expect(first.evidence()).toHaveLength(100);
  const next = harness("no-client", storage);
  await next.activate();
  expect(next.evidence()).toHaveLength(100);
  expect(next.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_ack", reason: "captured" }));
  await next.tap();
  expect(next.evidence().at(-1)).toMatchObject({ event: "notify_sw_open", reason: "ok" });
});

test("blocked diagnostic storage does not prevent delivery", async () => {
  const h = harness("current", { blocked: true });
  await h.tap();
  expect(h.calls).toEqual(["close", "message", "focus"]);
});
