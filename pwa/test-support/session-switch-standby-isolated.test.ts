// A relay that drops under a direct switch, through the real session, driver,
// commit and relay dial. The direct negotiation is a stand-in; the candidate is
// a real encrypted transport whose Ping the test answers or leaves unanswered.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { ProbeWire, deferred } from "./probe-wire-fixture";
import { SessionSocket, socketPair } from "./session-socket-fixture";
import { connectionDiagnostics } from "../src/lib/protocol/connection-diagnostics";
import type { LiveSession } from "../src/lib/protocol/session-types";
import * as upgrades from "../src/lib/protocol/session-upgrade";

let prepare: () => Promise<unknown> = () => new Promise(() => undefined);
mock.module("../src/lib/protocol/session-upgrade.ts", () => ({ ...upgrades, prepareDirectSession: () => prepare() }));
const { sessionOverWS } = await import("../src/lib/protocol/session-ws");

const realm = new Window();
let visibility = "visible";
Object.defineProperty(realm.document, "visibilityState", { get: () => visibility });
Object.defineProperty(globalThis, "document", { configurable: true, value: realm.document });
Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, writable: true, value: class {} });

let original: typeof WebSocket;
let live: LiveSession | undefined;
beforeEach(() => {
  original = globalThis.WebSocket;
  visibility = "visible";
  prepare = () => new Promise(() => undefined);
  SessionSocket.instances = []; SessionSocket.hold = "none"; SessionSocket.script = {}; SessionSocket.log = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SessionSocket });
});
afterEach(() => {
  live?.close(); live = undefined;
  for (const socket of SessionSocket.instances) socket.finishClose();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
});

async function until(ready: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await Bun.sleep(1);
  expect(ready()).toBe(true);
}
const sockets = () => SessionSocket.instances;
const logged = (entry: string) => SessionSocket.log.indexOf(entry);

/**
 * A relay session whose direct candidate has just sent TransportCommit into a
 * relay that will not answer. `answers` is whether the candidate's own path works.
 */
async function committing(answers: boolean) {
  const direct = new ProbeWire("p2p", 5);
  direct.hold = true;
  const negotiated = deferred<void>();
  let attempts = 0;
  prepare = () => attempts++ ? new Promise(() => undefined) : negotiated.promise.then(() => ({
    attemptId: "p2p_0123456789abcdef", iceGathering: "reflexive", channel: direct, epoch: direct.epoch(), close: () => direct.close(),
  }));
  live = await sessionOverWS("wss://pairfob.test/v2/ws", socketPair, { networkMode: "auto", p2p: true });
  const events: string[] = [];
  live.onEvent((event) => { if (event.type !== "latency") events.push(event.type === "terminal" ? `terminal:${event.code}` : event.type); });
  const first = sockets()[0]!;
  first.silent = true;
  const sent = first.frames.length;
  negotiated.resolve();
  await until(() => first.frames.length > sent);
  return { live, events, first, direct, answer: () => { direct.hold = false; if (answers) direct.confirmPing(); } };
}

test("a candidate that died with the relay costs one handshake, not its Ping deadline", async () => {
  const f = await committing(false);
  const started = Date.now();
  f.first.finishClose();
  // The replacement starts beside the candidate, not after it has failed.
  await until(() => logged("2:DeviceHello1") >= 0, 100);
  // isConnected alone can still describe the retained route during a switch;
  // observe the replacement's authenticated second flight before asserting it.
  await until(() => logged("2:DeviceHello3") >= 0 && f.live.isConnected());
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(sockets()).toHaveLength(2);
  // The candidate was given up before DeviceHello3 could make the computer retire its route.
  expect(f.direct.closed).toBe(true);
  expect(f.direct.requests.map((request) => request.op)).toEqual(["Ping"]);
  expect(f.events.filter((event) => event.startsWith("terminal"))).toEqual([]);
  expect(f.events.at(-1)).toBe("connected");
  const closes = connectionDiagnostics().filter((record) => record.event === "session_close" && record.transport === "p2p");
  expect(closes.map((record) => record.reason)).toEqual(["standby_ready"]);
});

test("a candidate that answers first carries the session and the replacement stops before DeviceHello3", async () => {
  const f = await committing(true);
  SessionSocket.hold = "hello";
  f.first.finishClose();
  await until(() => sockets()[1]?.blocked === "hello");
  f.answer();
  await until(() => f.live.isConnected());
  await until(() => sockets()[1]!.closeCalls > 0);
  sockets()[1]!.releaseLate();
  await Bun.sleep(20);
  expect(logged("2:DeviceHello3")).toBe(-1);
  expect(f.direct.closed).toBe(false);
  expect(sockets()).toHaveLength(2);
  expect(f.events.filter((event) => event.startsWith("terminal") || event === "disconnected")).toEqual([]);
  // Reads now travel the direct path.
  const read = f.live.snapshot();
  await until(() => f.direct.requests.some((request) => request.op === "Snapshot"));
  f.direct.reply(f.direct.requests.find((request) => request.op === "Snapshot")!, { ok: true });
  await expect(read).resolves.toEqual({ ok: true });
});

test("a replacement that is slower than the candidate's deadline is still the socket the dial uses", async () => {
  const f = await committing(false);
  SessionSocket.hold = "hello";
  const started = Date.now();
  f.first.finishClose();
  await until(() => sockets()[1]?.blocked === "hello");
  // The candidate's Ping runs out first; the handshake already under way is taken over, not restarted.
  await until(() => f.direct.closed, 4_000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
  sockets()[1]!.releaseLate();
  await until(() => f.live.isConnected());
  expect(sockets()).toHaveLength(2);
  expect(SessionSocket.log.filter((entry) => entry.endsWith(":DeviceHello1"))).toHaveLength(2);
}, 10_000);

test("a session taken over elsewhere starts no handshake of its own", async () => {
  const f = await committing(false);
  f.first.reject("kicked");
  await until(() => f.events.includes("terminal:kicked"));
  await Bun.sleep(20);
  expect(sockets()).toHaveLength(1);
});

test("a hidden page prepares nothing while its relay drops", async () => {
  const f = await committing(false);
  visibility = "hidden";
  realm.document.dispatchEvent(new realm.Event("visibilitychange"));
  f.first.finishClose();
  await Bun.sleep(50);
  expect(sockets()).toHaveLength(1);
});

test("an upgrade whose relay stays up starts no second handshake", async () => {
  const direct = new ProbeWire("p2p", 5);
  prepare = () => Promise.resolve({
    attemptId: "p2p_0123456789abcdef", iceGathering: "reflexive", channel: direct, epoch: direct.epoch(), close: () => direct.close(),
  });
  SessionSocket.script = { failOps: [] };
  live = await sessionOverWS("wss://pairfob.test/v2/ws", socketPair, { networkMode: "auto", p2p: true });
  await until(() => sockets()[0]!.operations.includes("TransportCommit"));
  await Bun.sleep(30);
  expect(sockets()).toHaveLength(1);
});
