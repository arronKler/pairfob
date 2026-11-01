// Child-process integration tests (spawned by
// src/lib/protocol/session-upload-probe-wait.test.ts). Lives in pwa/test-support/
// (the repository isolation location) so the default `bun test src` suite never
// collects it: like session-upload-v2-isolated.test.ts it stubs process-global
// network/negotiation I/O with mock.module. Production session, gate,
// DirectSessionDriver probe path, switch barrier and both AEAD transports are
// real code; the wire scripts encrypted Ping/probe outcomes.
import { expect, mock, test } from "bun:test";
import { ProbeWire } from "./probe-wire-fixture.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { fingerprint16 } from "../src/lib/protocol/hello.ts";
import * as sockets from "../src/lib/protocol/frame-socket.ts";
import * as handshake from "../src/lib/protocol/session-handshake.ts";
import * as upgrades from "../src/lib/protocol/session-upgrade.ts";
import type { UploadState, UploadWriteInput } from "../src/lib/protocol/attachments.ts";

let relay: ProbeWire;
let direct: ProbeWire;
let active: ProbeWire;

mock.module("../src/lib/protocol/frame-socket.ts", () => ({ ...sockets, openWS: async () => relay as never }));
mock.module("../src/lib/protocol/session-handshake.ts", () => ({
  ...handshake,
  establishSessionEpoch: async (channel: ProbeWire) => channel.epoch(),
}));
mock.module("../src/lib/protocol/session-upgrade.ts", () => ({
  ...upgrades,
  prepareDirectSession: async () => ({
    attemptId: "p2p_0123456789abcdef", iceGathering: "complete", channel: direct,
    epoch: direct.epoch(), close: () => direct.close(),
  }),
}));

const { sessionOverWS } = await import("../src/lib/protocol/session-ws.ts");

const pk = new Uint8Array(32).fill(3);
const pair = {
  daemonId: "d_" + "a".repeat(20), deviceId: "dev_12345678", daemonPk: pk, psk: new Uint8Array(32).fill(9),
  fp: fingerprint16(pk), endpointOrigin: "https://pairfob.com",
};

const URL_ = "wss://pairfob.com/v2/ws";
const PANE = "w1:p1";
const UPLOAD_ID = "00000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);

type Live = {
  isConnected(): boolean;
  isChecking(): boolean;
  close(): void;
  onEvent(listener: (event: { type: string }) => void): () => void;
  reconnectNow(reason: "path" | "probe"): void;
  switchTransport(target: "p2p" | "relay"): Promise<void>;
  sendText(paneId: string, text: string): Promise<unknown>;
  terminalInput(terminalId: string, sequence: number, data: Uint8Array): Promise<unknown>;
  workspaceUploadStatus(paneId: string, uploadId: string): Promise<UploadState>;
  workspaceUploadWrite(input: UploadWriteInput): Promise<UploadState>;
  workspaceUploadBegin(input: UploadWriteInput | Record<string, unknown>): Promise<UploadState>;
  workspaceUploadCancel(paneId: string, uploadId: string): Promise<UploadState>;
  workspaceUploadCommit(paneId: string, uploadId: string): Promise<UploadState>;
  workspaceUploadCancelV2(paneId: string, uploadId: string): Promise<UploadState>;
  workspaceUploadWriteV2(input: UploadWriteInput): Promise<UploadState>;
  workspaceUploadBeginV2(input: Record<string, unknown>): Promise<UploadState>;
  workspaceUploadCommitV2(paneId: string, uploadId: string): Promise<UploadState>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

function v2State(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    upload_id: UPLOAD_ID, state: "uploading", offset: 3, size: 262_144,
    sha256: SHA, chunk_bytes: 131_072, ...overrides,
  };
}
function legacyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    upload_id: UPLOAD_ID, state: "uploading", offset: 3, size: 262_144,
    sha256: SHA, chunk_bytes: 32_768, ...overrides,
  };
}

const writeInput = (offset: number): UploadWriteInput => ({
  pane_id: PANE, upload_id: UPLOAD_ID, offset, data_b64: "AAAA",
});

async function requestsFor(op: string, count: number, wire: ProbeWire = active, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = wire.requests.filter((request) => request.op === op);
    if (found.length >= count) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} ${op} (saw ${found.length})`);
    await sleep(2);
  }
}

function nonPingOps(wire: ProbeWire): string[] {
  return wire.requests.filter((request) => request.op !== "Ping").map((request) => request.op);
}

const UPLOAD_OPS = new Set([
  "WorkspaceUploadBegin", "WorkspaceUploadWrite", "WorkspaceUploadCommit", "WorkspaceUploadCancel",
  "WorkspaceUploadBeginV2", "WorkspaceUploadWriteV2", "WorkspaceUploadCommitV2", "WorkspaceUploadCancelV2",
]);

function uploadOps(wire: ProbeWire): string[] {
  return wire.requests.filter((request) => UPLOAD_OPS.has(request.op)).map((request) => request.op);
}

async function waitConnected(live: Live, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!live.isConnected() && Date.now() < deadline) await sleep(10);
  expect(live.isConnected()).toBe(true);
}

function gatePending(live: Live): number {
  return (live as unknown as { uploadReadiness: { pendingCount: number } }).uploadReadiness.pendingCount;
}

async function withSession(
  run: (live: Live, wire: ProbeWire) => Promise<void>,
  options: { p2p?: boolean; sessionP2P?: boolean } = {},
): Promise<void> {
  relay = new ProbeWire("relay", 1);
  direct = new ProbeWire("p2p", 2);
  const originalRTC = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, writable: true, value: class {} });
  const live = await sessionOverWS(URL_, pair as never, { networkMode: "relay", p2p: options.sessionP2P ?? true });
  try {
    active = relay;
    // The failed-switch scenario starts on Relay; transfer/probe cases
    // establish P2P through the production switch barrier.
    if (!options.p2p && options.sessionP2P !== false) {
      const switching = live.switchTransport("p2p");
      const commit = await relay.wait("TransportCommit") as { id: string; params: { attempt_id: string } };
      relay.reply(commit, { attempt_id: commit.params.attempt_id, route_id: bytesToHex(direct.route), transport: "webrtc" });
      await switching;
      active = direct;
    }
    await run(live as Live, active);
  } finally {
    live.close();
    relay.close();
    direct.close();
    if (originalRTC) Object.defineProperty(globalThis, "RTCPeerConnection", originalRTC);
    else delete (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  }
}

test("probe on the healthy same epoch pauses an unsent V2 write, sends zero frames, then dispatches exactly once", () => withSession(async (live, wire) => {
  wire.hold = true;
  live.reconnectNow("path");
  expect(live.isChecking()).toBe(true);
  const blocked = live.workspaceUploadWriteV2(writeInput(0));
  await settle();
  expect(gatePending(live)).toBe(1);
  expect(nonPingOps(wire)).toEqual([]); // nothing encrypted went out during checking

  wire.confirmPing();
  await waitConnected(live);
  const [request] = await requestsFor("WorkspaceUploadWriteV2", 1);
  expect(request.params).toMatchObject(writeInput(0));
  expect(gatePending(live)).toBe(0);
  wire.reply(request, v2State());
  const state = await blocked;
  expect(state.state).toBe("uploading");
  expect(state.chunk_bytes).toBe(131_072);
  expect(wire.requests.filter((entry) => entry.op === "WorkspaceUploadWriteV2")).toHaveLength(1);
}));

test("a failed probe rejects the unsent legacy write visibly with zero frames", () => withSession(async (live, oldWire) => {
  oldWire.hold = true;
  live.reconnectNow("path");
  await settle();
  const blocked = live.workspaceUploadWrite(writeInput(0));
  await settle();
  // Hand the recovery path a healthy new epoch before the failure lands, so
  // the session can reconnect; the waiter must still reject on the old one.
  relay = new ProbeWire("relay", 3);
  oldWire.failPing();
  await expect(blocked).rejects.toMatchObject({ code: "disconnected" });
  expect(nonPingOps(oldWire)).toEqual([]);
  await waitConnected(live);
  expect(relay.requests.some((entry) => entry.op === "WorkspaceUploadWrite")).toBe(false);
}));

test("an actual epoch replacement during checking rejects the waiter; the upload is never migrated", () => withSession(async (live, oldWire) => {
  oldWire.hold = true;
  live.reconnectNow("path");
  await settle();
  const blocked = live.workspaceUploadWriteV2(writeInput(0));
  await settle();

  const replacement = new ProbeWire("relay", 9);
  relay = replacement;
  oldWire.close();
  await expect(blocked).rejects.toMatchObject({ code: "disconnected" });
  expect(nonPingOps(oldWire)).toEqual([]);
  await waitConnected(live);
  // No automatic replay on the new epoch: the caller resumes explicitly.
  expect(uploadOps(replacement)).toEqual([]); // reconnect negotiation is allowed, upload replay is not
}));

test("explicit close() settles a paused upload promptly (no 8s deadline) with zero frames", () => withSession(async (live, wire) => {
  wire.hold = true;
  live.reconnectNow("path");
  await settle();
  const blocked = live.workspaceUploadWriteV2(writeInput(0));
  await settle();
  const start = Date.now();
  live.close();
  await expect(blocked).rejects.toMatchObject({ code: "disconnected" });
  expect(Date.now() - start).toBeLessThan(500);
  expect(nonPingOps(wire)).toEqual([]);
}));

test("a failed P2P switch never permits file transfer on the surviving relay", () => withSession(async (live, wire) => {
  const switching = live.switchTransport("p2p");
  const commit = (await wire.wait("TransportCommit")) as { id: string };
  expect(live.isConnected()).toBe(true); // relay itself never went through checking

  const blocked = live.workspaceUploadWriteV2(writeInput(0));
  await expect(blocked).rejects.toMatchObject({ code: "disconnected" });
  expect(uploadOps(wire)).toEqual([]);

  wire.reply(commit, null, false);
  await expect(switching).rejects.toThrow(/P2P|直连/);
  expect(live.isConnected()).toBe(true); // same epoch survived

  await expect(live.workspaceUploadWriteV2(writeInput(1))).rejects.toThrow("P2P");
  expect(uploadOps(wire)).toEqual([]);
}, { p2p: true }));

test("the bounded 8s wait rejects UNSENT with timeout and leaves no frames behind", () => withSession(async (live, wire) => {
  const realSetTimeout = globalThis.setTimeout;
  // Warp only the readiness deadline; the 4s probe budget stays real.
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn as (...a: unknown[]) => void, ms === 8_000 ? 30 : ms, ...args)) as unknown as typeof setTimeout;
  try {
    wire.hold = true;
    live.reconnectNow("path");
    await settle();
    const blocked = live.workspaceUploadWriteV2(writeInput(0));
    await expect(blocked).rejects.toMatchObject({ code: "timeout" });
    expect(gatePending(live)).toBe(0);
    expect(nonPingOps(wire)).toEqual([]);
    wire.confirmPing();
    await waitConnected(live);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}));

test("interactive mutations and terminal input still fail immediately during checking; Status reads stay unchanged", () => withSession(async (live, wire) => {
  wire.hold = true;
  live.reconnectNow("path");
  await settle();

  await expect(live.sendText(PANE, "no replay")).rejects.toMatchObject({ code: "disconnected" });
  await expect(live.terminalInput("term_" + "a".repeat(32), 1, new Uint8Array([65])))
    .rejects.toMatchObject({ code: "disconnected" });
  expect(nonPingOps(wire)).toEqual([]);

  // WorkspaceUploadStatus is a read and the frozen design leaves reads alone.
  const status = live.workspaceUploadStatus(PANE, UPLOAD_ID);
  const [statusReq] = await requestsFor("WorkspaceUploadStatus", 1);
  wire.reply(statusReq, legacyState({ offset: 0 }));
  const statusState = await status;
  expect(statusState.chunk_bytes).toBe(32_768);

  wire.confirmPing();
  await waitConnected(live);
}));

test("at most four uploads wait concurrently; the fifth rejects visibly and all four send once when ready", () => withSession(async (live, wire) => {
  wire.hold = true;
  live.reconnectNow("path");
  await settle();
  const parked = [0, 1, 2, 3].map((offset) => live.workspaceUploadWriteV2(writeInput(offset)));
  await settle();
  expect(gatePending(live)).toBe(4);
  await expect(live.workspaceUploadWriteV2(writeInput(4))).rejects.toMatchObject({ code: "backpressure" });
  expect(nonPingOps(wire)).toEqual([]);

  wire.confirmPing();
  const requests = await requestsFor("WorkspaceUploadWriteV2", 4);
  expect(new Set(requests.map((request) => request.params.offset as number))).toEqual(new Set([0, 1, 2, 3]));
  expect(new Set(requests.map((request) => request.params.operation_id as string)).size).toBe(4);
  for (const request of requests) wire.reply(request, v2State({ offset: 3 }));
  const states = await Promise.all(parked);
  expect(states).toHaveLength(4);
  expect(wire.requests.filter((entry) => entry.op === "WorkspaceUploadWriteV2")).toHaveLength(4);
  expect(gatePending(live)).toBe(0);
}));

test("the ready fast path is unchanged: upload begin/commit/cancel dispatch on both families without waiting", () => withSession(async (live, wire) => {
  expect(live.isConnected()).toBe(true);
  expect(gatePending(live)).toBe(0);

  const beginV2 = live.workspaceUploadBeginV2({
    pane_id: PANE, upload_id: UPLOAD_ID, name: "a.bin", size: 262_144,
    sha256: SHA, mime: "application/octet-stream",
  });
  const [beginReq] = await requestsFor("WorkspaceUploadBeginV2", 1);
  wire.reply(beginReq, v2State({ offset: 0 }));
  await beginV2;

  const commitV2 = live.workspaceUploadCommitV2(PANE, UPLOAD_ID);
  const [commitReq] = await requestsFor("WorkspaceUploadCommitV2", 1);
  wire.reply(commitReq, { ...v2State({ offset: 262_144, state: "committed" }),
    path: "/repo/.pairfob/attachments/1b7f/a.bin", relative_path: ".pairfob/attachments/1b7f/a.bin",
    name: "a.bin", mime: "application/octet-stream" });
  await expect(commitV2).resolves.toBeDefined();

  const beginLegacy = live.workspaceUploadBegin({
    pane_id: PANE, upload_id: UPLOAD_ID, name: "b.bin", size: 262_144,
    sha256: SHA, mime: "application/octet-stream",
  });
  const [legacyBeginReq] = await requestsFor("WorkspaceUploadBegin", 1);
  wire.reply(legacyBeginReq, legacyState({ offset: 0 }));
  await beginLegacy;

  const cancelLegacy = live.workspaceUploadCancel(PANE, UPLOAD_ID);
  const [cancelReq] = await requestsFor("WorkspaceUploadCancel", 1);
  wire.reply(cancelReq, { ...legacyState({ state: "cancelled" }) });
  await cancelLegacy;
}));


test("Relay blocks upload families while Status and cancellation remain usable", () => withSession(async (live, wire) => {
  const input = { pane_id: PANE, upload_id: UPLOAD_ID, name: "a.bin", size: 262144, sha256: SHA, mime: "application/octet-stream" };
  for (const send of [
    () => live.workspaceUploadBegin(input), () => live.workspaceUploadBeginV2(input),
    () => live.workspaceUploadWrite(writeInput(0)), () => live.workspaceUploadWriteV2(writeInput(0)),
    () => live.workspaceUploadCommit(PANE, UPLOAD_ID), () => live.workspaceUploadCommitV2(PANE, UPLOAD_ID),
  ]) await expect(send()).rejects.toThrow("P2P");
  expect(uploadOps(wire)).toEqual([]);
  const status = live.workspaceUploadStatus(PANE, UPLOAD_ID);
  const [read] = await requestsFor("WorkspaceUploadStatus", 1);
  wire.reply(read, legacyState());
  await status;
  const cancel = live.workspaceUploadCancel(PANE, UPLOAD_ID);
  const [remove] = await requestsFor("WorkspaceUploadCancel", 1);
  wire.reply(remove, legacyState({ state: "cancelled" }));
  await cancel;
  const cancelV2 = live.workspaceUploadCancelV2(PANE, UPLOAD_ID);
  const [removeV2] = await requestsFor("WorkspaceUploadCancelV2", 1);
  wire.reply(removeV2, v2State({ state: "cancelled" }));
  await cancelV2;
}, { p2p: true }));

test("a session created with p2p false sends upload Begin, Write and Commit on the relay", () => withSession(async (live, wire) => {
  const input = { pane_id: PANE, upload_id: UPLOAD_ID, name: "a.bin", size: 262144, sha256: SHA, mime: "application/octet-stream" };
  const begin = live.workspaceUploadBeginV2(input);
  const [beginReq] = await requestsFor("WorkspaceUploadBeginV2", 1);
  wire.reply(beginReq, v2State({ offset: 0 }));
  await begin;
  const write = live.workspaceUploadWriteV2(writeInput(0));
  const [writeReq] = await requestsFor("WorkspaceUploadWriteV2", 1);
  wire.reply(writeReq, v2State());
  await write;
  const commit = live.workspaceUploadCommitV2(PANE, UPLOAD_ID);
  const [commitReq] = await requestsFor("WorkspaceUploadCommitV2", 1);
  wire.reply(commitReq, { ...v2State({ offset: 262_144, state: "committed" }),
    path: "/repo/.pairfob/attachments/1b7f/a.bin", relative_path: ".pairfob/attachments/1b7f/a.bin",
    name: "a.bin", mime: "application/octet-stream" });
  await commit;
}, { sessionP2P: false }));
