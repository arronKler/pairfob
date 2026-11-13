import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { SessionSocket, socketPair } from "./session-socket-fixture";
import { DirectError } from "../src/lib/protocol/direct-peer";
import type { LiveSession } from "../src/lib/protocol/session-types";
import * as upgrades from "../src/lib/protocol/session-upgrade";

let starts = 0, cancels = 0, upgradesStarted = 0, takes = 0;
mock.module("../src/lib/protocol/direct-offer-warmup.ts", () => ({ DirectOfferWarmup: class {
  start() { starts++; }
  cancel() { cancels++; }
  take() { takes++; return Promise.reject(new DirectError("ice_timeout", "test ICE failure")); }
} }));
mock.module("../src/lib/protocol/session-upgrade.ts", () => ({ ...upgrades,
  prepareDirectSession: async (...args: unknown[]) => {
    upgradesStarted++;
    await (args[5] as () => Promise<unknown>)();
    throw new Error("unexpected successful preparation");
  },
}));
const { sessionOverWS } = await import("../src/lib/protocol/session-ws");
const realm = new Window();
Object.defineProperty(realm.document, "visibilityState", { get: () => "visible" });
Object.defineProperty(globalThis, "document", { configurable: true, value: realm.document });
Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: class {} });
let original: typeof WebSocket;
let live: LiveSession | undefined;
beforeEach(() => {
  starts = cancels = upgradesStarted = takes = 0;
  original = globalThis.WebSocket;
  SessionSocket.instances = []; SessionSocket.hold = "none"; SessionSocket.script = {};
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SessionSocket });
});
afterEach(() => {
  live?.close(); live = undefined;
  for (const socket of SessionSocket.instances) socket.finishClose();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
});
async function until(ready: () => boolean) {
  const end = Date.now() + 2000;
  while (!ready() && Date.now() < end) await Bun.sleep(1);
  expect(ready()).toBe(true);
}
const url = "wss://pairfob.test/v2/ws";

test("ICE starts beside authentication, but signaling waits for the established encrypted session", async () => {
  SessionSocket.hold = "hello";
  const opening = sessionOverWS(url, socketPair, { p2p: true });
  await until(() => SessionSocket.instances[0]?.blocked === "hello");
  expect(starts).toBe(1);
  expect(upgradesStarted).toBe(0);
  SessionSocket.instances[0]!.releaseLate();
  live = await opening;
  await until(() => upgradesStarted === 1);
  expect(takes).toBe(1);
  expect(starts).toBe(1);
  expect(live.isConnected()).toBe(true); // An ICE failure keeps the relay.
});

test("rejected device authentication cancels preparation without any signaling", async () => {
  SessionSocket.script = { refuseHello: "revoked" };
  await expect(sessionOverWS(url, socketPair, { p2p: true })).rejects.toMatchObject({ code: "revoked" });
  expect(starts).toBe(1);
  expect(cancels).toBeGreaterThan(0);
  expect(upgradesStarted).toBe(0);
});

test("relay-only mode and disabled P2P never prepare ICE", async () => {
  live = await sessionOverWS(url, socketPair, { p2p: true, networkMode: "relay" });
  expect(starts).toBe(0); live.close();
  live = await sessionOverWS(url, socketPair, { p2p: false });
  expect(starts).toBe(0);
  expect(upgradesStarted).toBe(0);
});
