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

function harness(mode: "current" | "old" | "closed" | "no-client" | "homepage") {
  const calls: string[] = [];
  const client: Client = {
    url: mode === "homepage" ? `${origin}/` : `${origin}/pair`,
    focus: async () => { calls.push("focus"); return client; },
    navigate: async url => { calls.push(`navigate:${url}`); return mode === "closed" ? null : client; },
    postMessage(data, ports) {
      expect(data).toEqual({ type: "pairfob_notify", url: target });
      calls.push("message");
      if (mode === "current") ports[0]!.postMessage({ type: "pairfob_notify_captured" });
    },
  };
  let click!: (event: unknown) => void;
  const scope = {
    location: { origin },
    addEventListener: (name: string, handler: typeof click) => { if (name === "notificationclick") click = handler; },
    clients: {
      matchAll: async () => mode === "no-client" ? [] : [client],
      openWindow: async (url: string) => { calls.push(`open:${url}`); },
    },
  };
  new Function("self", "setTimeout", worker)(scope, (callback: () => void) => setTimeout(callback, 30));
  return {
    calls,
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
