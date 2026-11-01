import { expect, test } from "bun:test";
import { createNativeNotify, type NativeNotification } from "./native-notify";
import type { NativeMessagePort } from "./native-app";

type Sent = { id: string; method: string } & Record<string, unknown>;

function fixture(timeout = 1000, permissionTimeout = 1000) {
  const sent: Sent[] = [];
  const port: NativeMessagePort = {
    postMessage: (message) => { sent.push(JSON.parse(message) as Sent); },
    onmessage: null,
  };
  const bridge = createNativeNotify(port, timeout, permissionTimeout);
  const reply = (index: number, value: unknown, ok = true) => {
    port.onmessage?.({ data: JSON.stringify({ id: sent[index].id, ok, value }) });
  };
  const event = (payload: unknown) => {
    port.onmessage?.({ data: JSON.stringify(payload) });
  };
  return { bridge, port, sent, reply, event };
}

const notice: NativeNotification = { title: "Needs you", body: "Claude · auth", tag: "pairfob-pane-p1", url: "/pair#notify=1&d=d_a&pane=p1" };

test("concurrent requests correlate out of order and carry their own fields", async () => {
  const { bridge, sent, reply } = fixture();
  const status = bridge.status();
  const permission = bridge.requestPermission();
  const posted = bridge.post(notice);
  expect(sent.map((item) => item.method)).toEqual(["status", "requestPermission", "post"]);
  expect(sent[2]).toMatchObject(notice);
  reply(2, { posted: true });
  reply(0, { permission: "granted", backgroundSync: true });
  reply(1, { permission: "granted" });
  expect(await status).toEqual({ permission: "granted", backgroundSync: true });
  expect(await permission).toBe("granted");
  await posted;
});

test("a malformed reply rejects only its call and never throws out of the event handler", async () => {
  const { bridge, port, sent, reply } = fixture();
  const status = bridge.status();
  port.onmessage?.({ data: "not JSON" });
  port.onmessage?.({ data: "null" });
  reply(0, { permission: "sometimes", backgroundSync: true });
  await expect(status).rejects.toThrow("invalid native notification response");

  const next = bridge.status();
  reply(1, { permission: "prompt", backgroundSync: false });
  expect(await next).toEqual({ permission: "prompt", backgroundSync: false });

  const post = bridge.post(notice);
  reply(2, { posted: false });
  await expect(post).rejects.toThrow("invalid native notification response");

  const denied = bridge.status();
  reply(3, null, false);
  await expect(denied).rejects.toThrow("native notification request failed");
});

test("a tap event reaches every listener until it unsubscribes", () => {
  const { bridge, event } = fixture();
  const seen: string[] = [];
  const stop = bridge.onTap((url) => { seen.push(url); });
  event({ event: "tap", url: "/pair#notify=1&d=d_a&pane=p1" });
  event({ event: "tap", url: "https://evil.example/pair#notify=1" });
  event({ event: "tap" });
  event({ event: "other" });
  expect(seen).toEqual(["/pair#notify=1&d=d_a&pane=p1"]);
  stop();
  event({ event: "tap", url: "/pair#notify=1&d=d_a&pane=p2" });
  expect(seen).toHaveLength(1);
});

test("requestPermission waits past the ordinary timeout for the OS dialog", async () => {
  const { bridge, sent, reply } = fixture(5, 1000);
  const status = bridge.status();
  const permission = bridge.requestPermission();
  await expect(status).rejects.toThrow("timed out");
  reply(1, { permission: "denied" });
  expect(await permission).toBe("denied");
  expect(sent[0].method).toBe("status");
});

test("ready consumes a tap from a cold start and rejects a malformed one", async () => {
  const { bridge, sent, reply } = fixture();
  const cold = bridge.ready();
  reply(0, { tap: { url: "/pair#notify=1&d=d_a&pane=p1" } });
  expect(await cold).toEqual({ url: "/pair#notify=1&d=d_a&pane=p1" });

  const empty = bridge.ready();
  reply(1, { tap: null });
  expect(await empty).toEqual({ url: null });

  const broken = bridge.ready();
  reply(2, { tap: { url: 7 } });
  await expect(broken).rejects.toThrow("invalid native notification response");
  expect(sent.map((item) => item.method)).toEqual(["ready", "ready", "ready"]);
});

test("background sync, cancel and cancelAll settle through their native replies", async () => {
  const { bridge, sent, reply } = fixture();
  const keep = bridge.setBackgroundSync(true);
  const cancelled = bridge.cancel("pairfob-pane-p1");
  const all = bridge.cancelAll();
  expect(sent[0]).toMatchObject({ method: "setBackgroundSync", on: true });
  expect(sent[1]).toMatchObject({ method: "cancel", tag: "pairfob-pane-p1" });
  reply(0, { backgroundSync: true });
  reply(1, { cancelled: true });
  reply(2, {});
  expect(await keep).toBe(true);
  await cancelled;
  await all;
});

test("a synchronous transport failure rejects the caller", async () => {
  const { bridge, port } = fixture();
  port.postMessage = () => { throw new Error("bridge gone"); };
  await expect(bridge.status()).rejects.toThrow("bridge gone");
});
