// Network/handshake mocks are process-global in Bun; the src wrapper runs this
// separately. Readiness, lifecycle listeners, AEAD and mutation delivery are real.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { Wire } from "./media-wire-fixture";
import { fingerprint16 } from "../src/lib/protocol/hello";
import { ProtocolError } from "../src/lib/protocol/errors";
import type { LiveSession } from "../src/lib/protocol/session-types";
import * as sockets from "../src/lib/protocol/frame-socket";
import * as handshake from "../src/lib/protocol/session-handshake";

class ProbeWire extends Wire {
  hold = false;
  pending: Array<{ req: { id: string }; result: unknown }> = [];
  override reply(req: { id: string }, result: unknown, ok = true) {
    if (this.hold && this.requests.find((r) => r.id === req.id)?.op === "Ping") {
      this.pending.push({ req, result });
      return;
    }
    super.reply(req, result, ok);
  }
  confirm() {
    const response = this.pending.shift()!;
    super.reply(response.req, response.result);
  }
}
let wire: ProbeWire;
let failConnect = false;
let socketOpens = 0;
mock.module("../src/lib/protocol/frame-socket", () => ({
  ...sockets, openWS: async () => {
    socketOpens++;
    if (failConnect) throw new ProtocolError("ws_open_failed", "fixture unavailable");
    return wire as never;
  },
}));
mock.module("../src/lib/protocol/session-handshake", () => ({
  ...handshake, establishSessionEpoch: async (channel: Wire) => channel.epoch(),
}));
const { sessionOverWS } = await import("../src/lib/protocol/session-ws");
const realm = new Window();
const document = Object.assign(new realm.EventTarget(), { visibilityState: "visible" });
Object.defineProperty(globalThis, "document", { configurable: true, value: document });
Object.defineProperty(globalThis, "window", { configurable: true, value: realm });
const pk = new Uint8Array(32).fill(3);
const pair = {
  daemonId: "d_" + "a".repeat(20), deviceId: "dev_12345678", daemonPk: pk, psk: new Uint8Array(32).fill(9),
  fp: fingerprint16(pk), relayOrigin: "https://pairfob.com",
};
let live: LiveSession | null;
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function visibility(hidden: boolean) {
  document.visibilityState = hidden ? "hidden" : "visible";
  document.dispatchEvent(new realm.Event("visibilitychange"));
}
async function connect() {
  live = await sessionOverWS("wss://pairfob.com/v2/ws", pair as never, { networkMode: "relay" });
  return live;
}
beforeEach(() => {
  socketOpens = 0;
  wire = new ProbeWire("relay", 1);
  failConnect = false;
  document.visibilityState = "visible";
});
afterEach(() => { live?.close(); live = null; wire.close(); });

test("a fresh page cannot report ready until the encrypted initial probe answers", async () => {
  wire.hold = true;
  let ready = false;
  const connecting = connect().then((session) => { ready = session.isConnected(); });
  await settle();
  expect(wire.pending).toHaveLength(1);
  expect(ready).toBe(false);
  wire.confirm();
  await connecting;
  expect(ready).toBe(true);
});

test("foreground checking blocks mutations without sending or replay and shares duplicate resume events", async () => {
  const session = await connect();
  const events: string[] = [];
  session.onEvent((event) => { if (event.type !== "latency") events.push(event.type); });
  wire.hold = true;
  visibility(true);
  expect(session.isConnected()).toBe(false);
  visibility(false);
  realm.dispatchEvent(new realm.Event("pageshow"));
  await settle();
  expect(wire.pending).toHaveLength(1);
  expect(session.isChecking?.()).toBe(true);
  await expect(session.sendText("w1:p1", "no replay")).rejects.toMatchObject({ code: "disconnected" });
  await expect(session.terminalInput("term_" + "a".repeat(32), 1, new Uint8Array([65])))
    .rejects.toMatchObject({ code: "disconnected" });
  expect(wire.requests.every((r) => r.op === "Ping")).toBe(true);
  wire.confirm();
  await settle();
  expect(session.isConnected()).toBe(true);
  expect(events).toEqual(["checking", "connected"]);
  expect(wire.requests.every((r) => r.op === "Ping")).toBe(true);
});

test("a late previous-foreground response cannot enable input in the next foreground", async () => {
  const session = await connect();
  wire.hold = true;
  visibility(true); visibility(false);
  await settle();
  visibility(true); visibility(false);
  await settle();
  expect(wire.pending).toHaveLength(2);
  wire.confirm();
  await settle();
  expect(session.isConnected()).toBe(false);
  wire.confirm();
  await settle();
  expect(session.isConnected()).toBe(true);
});

test("the first reconnect stays neutral, a failed attempt exposes persistent reconnecting", async () => {
  const session = await connect();
  failConnect = true;
  wire.close();
  expect(session.isChecking?.()).toBe(true);
  expect(session.isConnected()).toBe(false);
  await Bun.sleep(20);
  expect(session.isChecking?.()).toBe(false);
  expect(session.isConnected()).toBe(false);
});

test("background terminal cleanup still sends once while input is blocked", async () => {
  const session = await connect();
  visibility(true);
  const terminalId = "term_" + "a".repeat(32);
  const closing = session.terminalClose(terminalId);
  await settle();
  const request = wire.requests.find((r) => r.op === "TerminalClose")!;
  expect(request).toBeDefined();
  wire.reply(request, { operation_id: request.params.operation_id, terminal_id: terminalId, closed: true });
  await closing;
  expect(wire.requests.filter((r) => r.op === "TerminalClose")).toHaveLength(1);
  expect(session.isConnected()).toBe(false);
});

test("a brief connection drop remains checking until the replacement epoch answers", async () => {
  const session = await connect();
  const old = wire;
  wire = new ProbeWire("relay", 2);
  wire.hold = true;
  old.close();
  await Bun.sleep(20);
  expect(wire.pending).toHaveLength(1);
  expect(session.isChecking?.()).toBe(true);
  expect(session.isConnected()).toBe(false);
  wire.confirm();
  await settle();
  expect(session.isChecking?.()).toBe(false);
  expect(session.isConnected()).toBe(true);
});


test("silent foreground consumes the prepared relay once without replaying blocked mutations", async () => {
  const session = await connect();
  const old = wire;
  old.hold = true;
  visibility(true); visibility(false);
  await settle();
  wire = new ProbeWire("relay", 2);
  wire.hold = true;
  await expect(session.sendText("w1:p1", "must not replay")).rejects.toMatchObject({ code: "disconnected" });
  await Bun.sleep(600);
  expect(socketOpens).toBe(2);
  expect(wire.requests).toHaveLength(0); // Warmup has not authenticated or sent RPCs.
  const deadline = Date.now() + 3500;
  while (wire.pending.length === 0 && Date.now() < deadline) await Bun.sleep(10);
  expect(wire.pending).toHaveLength(1);
  expect(socketOpens).toBe(2);
  expect(session.isConnected()).toBe(false);
  wire.confirm(); await settle();
  expect(session.isConnected()).toBe(true);
  expect(old.closed).toBe(true);
  expect([...old.requests, ...wire.requests].every(r => r.op === "Ping")).toBe(true);
  old.confirm(); await settle();
  expect(session.isConnected()).toBe(true);
}, 5000);
