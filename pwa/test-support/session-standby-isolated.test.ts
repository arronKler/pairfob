// Real handshake, AEAD and session state machine against the in-memory relay +
// daemon peer; only the socket and the page's visibility are stand-ins.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { SessionSocket, socketPair } from "./session-socket-fixture";
import { sessionOverWS } from "../src/lib/protocol/session-ws";
import { connectionDiagnostics } from "../src/lib/protocol/connection-diagnostics";
import type { LiveSession } from "../src/lib/protocol/session-types";

const realm = new Window();
let visibility = "visible";
Object.defineProperty(realm.document, "visibilityState", { get: () => visibility });
Object.defineProperty(globalThis, "document", { configurable: true, value: realm.document });

let original: typeof WebSocket;
let live: LiveSession | undefined;
let skew = 0;
const realNow = Date.now.bind(Date);
let clock: ReturnType<typeof spyOn>;
beforeEach(() => {
  original = globalThis.WebSocket;
  visibility = "visible"; skew = 0;
  clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  SessionSocket.instances = []; SessionSocket.hold = "none"; SessionSocket.script = {}; SessionSocket.log = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SessionSocket });
});
afterEach(() => {
  live?.close(); live = undefined;
  for (const socket of SessionSocket.instances) socket.finishClose();
  clock.mockRestore();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
});

async function until(ready: () => boolean, ms = 2000) {
  const end = realNow() + ms;
  while (!ready() && realNow() < end) await Bun.sleep(1);
  expect(ready()).toBe(true);
}
function show(hidden: boolean) {
  visibility = hidden ? "hidden" : "visible";
  realm.document.dispatchEvent(new realm.Event("visibilitychange"));
}
/** Hide the page, let `ms` of wall time pass while it is suspended, and bring it back. */
function away(ms: number) { show(true); skew += ms; show(false); }
async function connected() {
  live = await sessionOverWS("wss://pairfob.test/v2/ws", socketPair, { networkMode: "relay" });
  const events: string[] = [];
  live.onEvent((event) => { if (event.type !== "latency") events.push(event.type === "terminal" ? `terminal:${event.code}` : event.type); });
  return { live, events, first: SessionSocket.instances[0]! };
}
const sockets = () => SessionSocket.instances;
const logged = (entry: string) => SessionSocket.log.indexOf(entry);

test("returning to a silently dead path reconnects in one handshake instead of waiting out the Ping", async () => {
  const f = await connected();
  // The screen read its config and snapshot, so the next dial asks ahead for both.
  await f.live.getConfig();
  await f.live.snapshot();
  f.first.silent = true;
  const started = realNow();
  away(30_000);
  // The second handshake starts with the probe, not after it has failed.
  await until(() => logged("2:DeviceHello1") >= 0, 100);
  await until(() => f.live.isConnected());
  expect(realNow() - started).toBeLessThan(1_000);
  expect(sockets()).toHaveLength(2);
  expect(sockets()[1]!.operations).toEqual(["Ping", "GetConfig", "Snapshot"]);
  // The old path was retired before DeviceHello3 could make the computer kick it.
  expect(logged("1:close")).toBeGreaterThanOrEqual(0);
  expect(logged("1:close")).toBeLessThan(logged("2:DeviceHello3"));
  f.first.reject("kicked");
  await Bun.sleep(20);
  expect(f.live.isConnected()).toBe(true);
  expect(f.events.filter((event) => event.startsWith("terminal"))).toEqual([]);
  expect(f.events.at(-1)).toBe("connected");
  const reasons = connectionDiagnostics().filter((record) => record.event === "probe_failed").map((record) => record.reason);
  expect(reasons).toContain("standby_ready");
});

test("returning to a healthy path keeps it and abandons the standby before DeviceHello3", async () => {
  const f = await connected();
  SessionSocket.hold = "hello";
  // Keep the old path's probe pending until the standby actually sent Hello1.
  // Native key generation may otherwise be cancelled before any auth leaves.
  f.first.script = { slowOps: ["Ping"] };
  const sent = f.first.requests.length;
  away(30_000);
  await until(() => sockets()[1]?.blocked === "hello");
  const probe = f.first.requests.slice(sent).find((request) => request.op === "Ping")!;
  expect(probe.op).toBe("Ping");
  f.first.answer(probe.id, { t_ms: probe.params.t_ms });
  await until(() => f.live.isConnected());
  await until(() => sockets().length === 2 && sockets()[1]!.closeCalls > 0);
  sockets()[1]!.releaseLate();
  await Bun.sleep(20);
  expect(logged("2:DeviceHello1")).toBeGreaterThanOrEqual(0);
  expect(logged("2:DeviceHello3")).toBe(-1);
  expect(logged("1:close")).toBe(-1);
  expect(f.live.isConnected()).toBe(true);
  expect(f.events).toEqual(["checking", "connected"]);
  expect(sockets()).toHaveLength(2);
});

test("a short absence starts no second handshake", async () => {
  const f = await connected();
  away(5_000);
  await until(() => f.live.isConnected());
  await Bun.sleep(20);
  expect(sockets()).toHaveLength(1);
  expect(f.events).toEqual(["checking", "connected"]);
});

test("a refused standby changes nothing: the probe still decides, on a socket prepared meanwhile", async () => {
  const f = await connected();
  f.first.silent = true;
  SessionSocket.script = { refuseHello: "rate_limited" };
  const started = realNow();
  away(30_000);
  await until(() => sockets().length === 3 && sockets()[1]!.closeCalls > 0);
  // Only the standby's handshake was refused; the computer admits the next one.
  sockets()[2]!.script = {};
  await Bun.sleep(20);
  // Refused: nothing retired, nothing established, and a plain socket stands by.
  expect(logged("2:DeviceHello3")).toBe(-1);
  expect(logged("1:close")).toBe(-1);
  expect(logged("3:DeviceHello1")).toBe(-1);
  expect(f.live.isChecking?.()).toBe(true);
  expect(f.events).toEqual(["checking"]);
  // The Ping deadline retires the old path; the prepared socket carries the dial.
  await until(() => f.live.isConnected(), 5_000);
  expect(realNow() - started).toBeGreaterThanOrEqual(2_900);
  expect(sockets()).toHaveLength(3);
  expect(logged("1:close")).toBeLessThan(logged("3:DeviceHello1"));
  expect(f.events.filter((event) => event.startsWith("terminal"))).toEqual([]);
}, 10_000);

test("a path that died while hidden is answered by a dial, and a later network hint starts no standby", async () => {
  const f = await connected();
  show(true);
  skew += 30_000;
  f.first.finishClose();
  show(false);
  await until(() => sockets().length === 2 && f.live.isConnected());
  f.live.reconnectNow("path");
  f.live.reconnectNow("probe");
  await until(() => f.live.isConnected());
  await Bun.sleep(20);
  expect(sockets()).toHaveLength(2);
  expect(SessionSocket.log.filter((entry) => entry.endsWith(":DeviceHello1"))).toHaveLength(2);
});

test("hiding again abandons a standby in flight", async () => {
  const f = await connected();
  f.first.silent = true;
  SessionSocket.hold = "hello";
  away(30_000);
  await until(() => sockets()[1]?.blocked === "hello");
  show(true);
  expect(sockets()[1]!.closeCalls).toBeGreaterThan(0);
  sockets()[1]!.releaseLate();
  await Bun.sleep(20);
  expect(logged("2:DeviceHello3")).toBe(-1);
  expect(logged("1:close")).toBe(-1);
  expect(f.events.filter((event) => event.startsWith("terminal"))).toEqual([]);
});

test("a session that has spent its handshake share returns with the plain probe", async () => {
  const f = await connected();
  for (let dial = 1; dial < 4; dial++) {
    sockets()[dial - 1]!.finishClose();
    await until(() => sockets().length === dial + 1 && f.live.isConnected());
  }
  sockets()[3]!.silent = true;
  away(30_000);
  await Bun.sleep(50);
  expect(sockets()).toHaveLength(4);
  expect(f.live.isChecking?.()).toBe(true);
});

test("the computer replacing a live session is still terminal", async () => {
  const f = await connected();
  f.first.reject("kicked");
  await until(() => f.events.includes("terminal:kicked"));
  expect(f.live.isConnected()).toBe(false);
  await Bun.sleep(20);
  expect(sockets()).toHaveLength(1);
});
