// Runs in its OWN bun test process (spawned from src/lib/protocol/workspace-media-ownership.test.ts).
// This file intentionally lives in test-support/ so it is never collected by the
// default `bun test src` suite: it stubs network/negotiation I/O with mock.module,
// which is process-global in bun and must not share a process with frame-socket's
// real openWS tests.
import { test, expect, mock } from "bun:test";
import { Wire } from "./media-wire-fixture";
import { fingerprint16 } from "../src/lib/protocol/hello";
import { bytesToHex } from "../src/lib/protocol/bytes";
import * as sockets from "../src/lib/protocol/frame-socket";
import * as handshake from "../src/lib/protocol/session-handshake";
import * as upgrades from "../src/lib/protocol/session-upgrade";

let relay: Wire;
let direct: Wire;

// Stub only network/negotiation I/O. The public session, the real
// DirectSessionDriver/TransportSwitchBarrier, TransportCommit + post-commit Ping
// barrier, both real AEAD transports and the media methods stay production code.
mock.module("../src/lib/protocol/frame-socket", () => ({ ...sockets, openWS: async () => relay as never }));
mock.module("../src/lib/protocol/session-handshake", () => ({
  ...handshake,
  establishSessionEpoch: async (channel: Wire) => channel.epoch(),
}));
mock.module("../src/lib/protocol/session-upgrade", () => ({
  ...upgrades,
  prepareDirectSession: async () => ({
    attemptId: "p2p_0123456789abcdef", iceGathering: "complete", channel: direct,
    epoch: direct.epoch(), close: () => direct.close(),
  }),
}));

const { sessionOverWS } = await import("../src/lib/protocol/session-ws") as {
  sessionOverWS(url: string, pair: object, opts: object): Promise<Live>;
};

const handle = "media_" + "a".repeat(32);
const pk = new Uint8Array(32).fill(3);
const pair = {
  daemonId: "d_" + "a".repeat(20), deviceId: "dev_12345678", daemonPk: pk, psk: new Uint8Array(32).fill(9),
  fp: fingerprint16(pk), relayOrigin: "https://pairfob.com",
};

type Live = {
  isConnected(): boolean;
  close(): void;
  switchTransport(target: string): Promise<void>;
  workspaceMediaOpen(paneId: string, path: string): Promise<unknown>;
};

async function withSession(run: (live: Live, deadlines: number[]) => Promise<void>) {
  relay = new Wire("relay", 1);
  direct = new Wire("p2p", 2);
  const originalRTC = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, writable: true, value: class {} });
  const originalTimer = globalThis.setTimeout;
  const deadlines: number[] = [];
  const live = await sessionOverWS("wss://pairfob.com/v2/ws", pair as never, { p2p: true, networkMode: "relay" });
  globalThis.setTimeout = ((fn: unknown, ms: number, ...args: unknown[]) => {
    if (ms === 20000) deadlines.push(ms);
    return originalTimer(fn as (...a: unknown[]) => void, ms === 20000 ? 5 : ms, ...args);
  }) as typeof setTimeout;
  try {
    await run(live, deadlines);
  } finally {
    live.close();
    relay.close();
    direct.close();
    globalThis.setTimeout = originalTimer;
    if (originalRTC) Object.defineProperty(globalThis, "RTCPeerConnection", originalRTC);
    else delete (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  }
}

test("same owner late Open uses the 20s deadline and closes its handle once on relay", async () => withSession(async (live, deadlines) => {
  const error = await live.workspaceMediaOpen("w1:p1", "a.bin").catch((e: unknown) => e) as { code: string };
  expect(error.code).toBe("timeout");
  const open = await relay.wait("WorkspaceMediaOpen") as { id: string };
  relay.reply(open, { handle });
  const close = await relay.wait("WorkspaceMediaClose") as { params: Record<string, unknown> };
  expect(close.params).toEqual({ handle });
  relay.reply(open, { handle });
  await Promise.resolve();
  expect(relay.requests.filter((r) => r.op === "WorkspaceMediaOpen")).toHaveLength(1);
  expect(relay.requests.filter((r) => r.op === "WorkspaceMediaClose")).toHaveLength(1);
  expect(direct.requests).toHaveLength(0);
  expect(deadlines).toEqual([20000]);
}));

test("late Open under the real P2P commit barrier does not close on the replacement epoch", async () => withSession(async (live, deadlines) => {
  const error = await live.workspaceMediaOpen("w1:p1", "a.bin").catch((e: unknown) => e) as { code: string };
  expect(error.code).toBe("timeout");
  const open = await relay.wait("WorkspaceMediaOpen") as { id: string };

  const switching = live.switchTransport("p2p");
  const commit = await relay.wait("TransportCommit") as { params: { attempt_id: string } };

  relay.reply(open, { handle });
  await Promise.resolve();
  await Promise.resolve();
  const before = relay.requests.filter((r) => r.op === "WorkspaceMediaClose").length;

  relay.reply(commit, { attempt_id: commit.params.attempt_id, route_id: bytesToHex(direct.route), transport: "webrtc" });
  await switching;
  await Promise.race([relay.wait("WorkspaceMediaClose"), direct.wait("WorkspaceMediaClose")]).catch(() => undefined);

  expect(live.isConnected()).toBe(true);
  expect(relay.closed).toBe(true);
  expect(direct.requests.filter((r) => r.op === "WorkspaceMediaClose")).toHaveLength(0);
  const relayCloses = relay.requests.filter((r) => r.op === "WorkspaceMediaClose").length;
  expect(relayCloses).toBeGreaterThanOrEqual(before);
  expect(deadlines).toEqual([20000]);
}));
