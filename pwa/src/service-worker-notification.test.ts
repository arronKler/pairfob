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

type Storage = { body?: string; blocked?: boolean; resolutions?: Map<string, string>; language?: Promise<void>; failShows?: number };
type NoticeOptions = { tag?: string; renotify?: boolean; silent?: boolean; body?: string; data?: { event?: string; event_at?: string; kind?: string; url?: string } };
type Notice = NoticeOptions & { title: string; close(): void };
function harness(mode: "current" | "old" | "closed" | "no-client" | "homepage" | "focus-rejected", storage: Storage = {}) {
  const calls: string[] = [];
  const shown: Notice[] = [];
  const deliveries: NoticeOptions[] = [];
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
  let push!: (event: unknown) => void;
  const scope = {
    location: { origin },
    addEventListener: (name: string, handler: typeof click) => {
      if (name === "notificationclick") click = handler;
      if (name === "activate") activate = handler;
      if (name === "push") push = handler;
    },
    registration: {
      showNotification: async (title: string, options: NoticeOptions) => {
        if (storage.failShows) { storage.failShows--; throw new Error("notification unavailable"); }
        calls.push(`show:${title}:${options.tag}`);
        deliveries.push(options);
        const old = shown.findIndex(notice => notice.tag === options.tag);
        if (old >= 0) shown.splice(old, 1);
        const notice: Notice = {
          title,
          ...options,
          close: () => {
            calls.push(`close-notice:${options.tag}`);
            const at = shown.indexOf(notice);
            if (at >= 0) shown.splice(at, 1);
          },
        };
        shown.push(notice);
      },
      getNotifications: async (filter: { tag?: string } = {}) =>
        shown.filter((notice) => !filter.tag || notice.tag === filter.tag),
    },
    clients: {
      matchAll: async () => mode === "no-client" ? [] : [client],
      openWindow: async (url: string) => { calls.push(`open:${url}`); return client; },
      claim: async () => {},
    },
  };
  const cacheStorage = {
    open: async (name: string) => {
      if (storage.blocked) throw new Error("storage unavailable");
      const resolutions = storage.resolutions ??= new Map<string, string>();
      return {
        match: async (key: string) => {
          if (name === "pairfob-pref") { await storage.language; return undefined; }
          const body = name === "pairfob-notification-resolved-v1" ? resolutions.get(key) : storage.body;
          return body ? new Response(body) : undefined;
        },
        put: async (key: string, response: Response) => {
          const body = await response.text();
          if (name === "pairfob-notification-resolved-v1") resolutions.set(key, body);
          else storage.body = body;
        },
        keys: async () => [...resolutions.keys()],
        delete: async (key: string) => resolutions.delete(key),
      };
    },
    keys: async () => ["pairfob-shell-v9", "pairfob-notification-diagnostics-v1"],
    delete: async (key: string) => { if (key === "pairfob-notification-diagnostics-v1") delete storage.body; },
  };
  new Function("self", "setTimeout", "caches", worker)(scope, (callback: () => void) => setTimeout(callback, 30), cacheStorage);
  return {
    calls,
    deliveries,
    shown: () => shown,
    evidence: (): Array<{ event: string; reason?: string }> => JSON.parse(storage.body || "[]"),
    async activate() {
      let pending!: Promise<unknown>;
      activate({ waitUntil: (work: Promise<unknown>) => { pending = work; } });
      await pending;
    },
    async notify(data: unknown) {
      let pending!: Promise<unknown>;
      push({ data: { json: () => data }, waitUntil: (work: Promise<unknown>) => { pending = work; } });
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

test("a needs-you push shows one notice with its pane tag", async () => {
  const h = harness("no-client");
  await h.notify({ title: "Pairfob · 需要你处理", body: "Claude · auth", kind: "needs_you", tag: "pairfob-pane-abc", url: target });
  expect(h.calls).toEqual(["show:Pairfob · Waiting for you:pairfob-pane-abc"]);
  expect(h.shown()).toHaveLength(1);
  expect(h.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_shown" }));
});

test("a retraction replaces the wait with a visible quiet resolution", async () => {
  const h = harness("no-client");
  await h.notify({ kind: "needs_you", tag: "pairfob-pane-abc", url: target });
  h.calls.length = 0;
  await h.notify({ kind: "retract", tag: "pairfob-pane-abc" });
  expect(h.calls).toEqual(["show:Pairfob · No longer waiting:pairfob-pane-abc"]);
  expect(h.shown()).toHaveLength(1);
  expect(h.deliveries.at(-1)).toMatchObject({ silent: true, renotify: false });
  expect(h.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_retract", reason: "resolved" }));
});

test("a retraction for an older episode leaves the current notice alone", async () => {
  const h = harness("no-client");
  await h.notify({ kind: "needs_you", tag: "pairfob-pane-abc", event: "att_new", url: target });
  await h.notify({ kind: "retract", tag: "pairfob-pane-abc", event: "att_old" });
  expect(h.calls.filter((call) => call.startsWith("close-notice"))).toHaveLength(0);
  expect(h.shown()).toHaveLength(1);
  expect(h.shown()[0].data?.event).toBe("att_new");
  expect(h.deliveries).toHaveLength(2);
  expect(h.evidence()).toContainEqual(expect.objectContaining({ event: "notify_sw_retract", reason: "preserved" }));
});

test("a retraction without a matching notice still fulfills userVisibleOnly", async () => {
  const h = harness("no-client");
  await h.notify({ kind: "retract", tag: "pairfob-pane-gone" });
  expect(h.calls).toEqual(["show:Pairfob · No longer waiting:pairfob-pane-gone"]);
  expect(h.deliveries[0]).toMatchObject({ silent: true, renotify: false });
});

test("escalation reminders alert again while replacing the same tag", async () => {
  const h = harness("no-client");
  const data = { kind: "needs_you", tag: "pane", event: "att_one", url: target };
  await h.notify(data);
  await h.notify(data);
  expect(h.shown()).toHaveLength(1);
  expect(h.deliveries).toHaveLength(2);
  expect(h.deliveries.every(options => options.renotify && !options.silent)).toBe(true);
});

test("a resolution waits for an in-flight notification to finish", async () => {
  let release!: () => void;
  const language = new Promise<void>(resolve => { release = resolve; });
  const h = harness("no-client", { language });
  const showing = h.notify({ kind: "needs_you", tag: "pane", event: "att_one", url: target });
  const resolving = h.notify({ kind: "retract", tag: "pane", event: "att_one", url: target });
  await Bun.sleep(0);
  expect(h.deliveries).toHaveLength(0);
  release();
  await Promise.all([showing, resolving]);
  expect(h.deliveries).toHaveLength(2);
  expect(h.shown()[0].title).toBe("Pairfob · No longer waiting");
});

test("a delayed wait cannot restore a resolved episode after worker restart", async () => {
  const storage: Storage = {};
  const first = harness("no-client", storage);
  await first.notify({ kind: "retract", tag: "pane", event: "att_one", url: target });
  const next = harness("no-client", storage);
  await next.notify({ kind: "needs_you", tag: "pane", event: "att_one", url: target });
  expect(next.shown()[0].title).toBe("Pairfob · No longer waiting");
  expect(next.deliveries[0]).toMatchObject({ renotify: false, silent: true });
});

test("a delayed old wait preserves a newer displayed episode", async () => {
  const h = harness("no-client");
  await h.notify({ kind: "retract", tag: "pane", event: "att_old" });
  await h.notify({ kind: "needs_you", tag: "pane", event: "att_new", url: target });
  await h.notify({ kind: "needs_you", tag: "pane", event: "att_old", url: target });
  expect(h.shown()[0].data?.event).toBe("att_new");
  expect(h.deliveries).toHaveLength(3);
  expect(h.deliveries.at(-1)).toMatchObject({ silent: true, renotify: false });
});

test("a newer resolution replaces an older wait even within the same second", async () => {
  const h = harness("no-client");
  await h.notify({ kind: "needs_you", tag: "pane", event: "att_old", event_at: "1794886800000000001" });
  await h.notify({ kind: "retract", tag: "pane", event: "att_new", event_at: "1794886800000000002" });
  expect(h.shown()[0].title).toBe("Pairfob · No longer waiting");
  expect(h.shown()[0].data?.event).toBe("att_new");
});

test("an older resolution cannot overwrite a completion", async () => {
  const h = harness("no-client");
  await h.notify({ kind: "done", tag: "pane", url: target });
  await h.notify({ kind: "retract", tag: "pane", event: "att_old" });
  expect(h.shown()[0].title).toBe("Pairfob · Turn finished");
  expect(h.deliveries).toHaveLength(2);
});

test("blocked storage keeps resolution ordering within the worker lifetime", async () => {
  const h = harness("no-client", { blocked: true });
  await h.notify({ kind: "retract", tag: "pane", event: "att_one" });
  await h.notify({ kind: "needs_you", tag: "pane", event: "att_one" });
  expect(h.shown()[0].title).toBe("Pairfob · No longer waiting");
});

test("a failed display does not prevent later notification delivery", async () => {
  const h = harness("no-client", { failShows: 1 });
  await expect(h.notify({ kind: "needs_you", tag: "pane" })).rejects.toThrow();
  await h.notify({ kind: "needs_you", tag: "pane" });
  expect(h.deliveries).toHaveLength(1);
});
