import { describe, expect, test } from "bun:test";
import { enqueueHandshakeFrame, heartbeatPayload, MAX_HANDSHAKE_QUEUE, MUTATION_RPC_TIMEOUT_MS, normalizeDeviceLabel, ProtocolError, READ_RPC_TIMEOUT_MS, TERMINAL_RPC_TIMEOUT_MS, trackMutationDelivery, validateEstablishedFWD, validateSessionEstablished, validateSessionMessage } from "./client.ts";
import { jsonFrame, Typ } from "./envelope.ts";
import { bytesToHex } from "./bytes.ts";
import { reconcileMutationFailure } from "../operations.ts";

describe("session control frames", () => {
  test("heartbeat is exactly uint64 big-endian", () => {
    expect([...heartbeatPayload(0x0102_0304_0506_0708n)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(heartbeatPayload(1n).byteLength).toBe(8);
    expect(() => heartbeatPayload(-1n)).toThrow(RangeError);
  });

  test("requires matching non-FWD SESSION_ESTABLISHED envelope and JSON route", () => {
    const route = Uint8Array.from({ length: 16 }, (_, index) => index);
    const valid = jsonFrame(Typ.SESSION_ESTABLISHED, route, { v: 1, route_id: bytesToHex(route) });
    expect(() => validateSessionEstablished(valid, route)).not.toThrow();
    expect(() => validateSessionEstablished(jsonFrame(Typ.SESSION_ESTABLISHED, route, { v: 2, route_id: bytesToHex(route) }), route, 2)).not.toThrow();
    expect(() => validateSessionEstablished(jsonFrame(Typ.SESSION_ESTABLISHED, route, { v: 2, route_id: bytesToHex(route) }), route)).toThrow(ProtocolError);
    expect(() => validateSessionEstablished(jsonFrame(Typ.FWD, route, { v: 1, route_id: bytesToHex(route) }), route)).toThrow(ProtocolError);
    expect(() => validateSessionEstablished(jsonFrame(Typ.SESSION_ESTABLISHED, route, { v: 1, route_id: "00" }), route)).toThrow(ProtocolError);
  });

  test("Established accepts only same-route FWD and bounds handshake buffering", () => {
    const route = new Uint8Array(16);
    expect(() => validateEstablishedFWD(jsonFrame(Typ.FWD, route, {}), route)).not.toThrow();
    expect(() => validateEstablishedFWD(jsonFrame(Typ.FWD, new Uint8Array(16).fill(1), {}), route)).toThrow("route_id");
    expect(() => validateEstablishedFWD(jsonFrame(Typ.SESSION_BOUND, route, {}), route)).toThrow("控制帧");
    expect(MAX_HANDSHAKE_QUEUE).toBe(64);
    const frame = jsonFrame(Typ.PONG, route, {});
    const queue: typeof frame[] = [];
    for (let index = 0; index < MAX_HANDSHAKE_QUEUE; index++) enqueueHandshakeFrame(queue, frame);
    expect(() => enqueueHandshakeFrame(queue, frame)).toThrow("队列溢出");
  });

  test("strictly validates decrypted RPC responses, daemon Ping, and Poke", () => {
    expect(validateSessionMessage({ v: 1, id: "req_1", ok: true, result: null })).toEqual({ kind: "response", id: "req_1", ok: true, result: null });
    expect(validateSessionMessage({ v: 1, id: "ping_1", op: "Ping", params: { t_ms: 7 } })).toEqual({ kind: "request", id: "ping_1", tMs: 7 });
    expect(validateSessionMessage({ v: 1, op: "Poke", params: { reason: "agent_status", pane_id: "w0:p1" } })).toEqual({ kind: "poke", reason: "agent_status", paneId: "w0:p1" });
    expect(() => validateSessionMessage({ v: 1, id: "req_1", ok: "yes", result: {} })).toThrow(ProtocolError);
    expect(() => validateSessionMessage({ v: 1, id: "req_1", ok: true, result: {}, error: {} })).toThrow(ProtocolError);
    expect(() => validateSessionMessage({ v: 1, id: "req_1", ok: false, error: { code: "made_up", message: "x" } })).toThrow(ProtocolError);
    expect(() => validateSessionMessage({ v: 1, op: "Poke", params: { reason: "made_up" } })).toThrow(ProtocolError);
    expect(() => validateSessionMessage({ v: 1, id: "ping_1", op: "Snapshot", params: {} })).toThrow(ProtocolError);
  });

  test("strictly validates complete-terminal events", () => {
    const terminalId = "term_0123456789abcdef0123456789abcdef";
    const frame = validateSessionMessage({
      v: 1,
      op: "TerminalFrame",
      params: { terminal_id: terminalId, seq: "7", width: 80, height: 24, full: true, index: 0, count: 1, data: "G1sySg==" },
    });
    expect(frame.kind).toBe("terminal_frame");
    if (frame.kind === "terminal_frame") expect(frame.frame.data).toEqual(new Uint8Array([27, 91, 50, 74]));
    expect(validateSessionMessage({
      v: 1, op: "TerminalClosed", params: { terminal_id: terminalId, reason: "released" },
    })).toEqual({ kind: "terminal_closed", terminalId, reason: "released" });
    expect(() => validateSessionMessage({
      v: 1,
      op: "TerminalFrame",
      params: { terminal_id: terminalId, seq: 7, width: 80, height: 24, full: true, index: 0, count: 1, data: "" },
    })).toThrow(ProtocolError);
    expect(() => validateSessionMessage({
      v: 1,
      op: "TerminalFrame",
      params: { terminal_id: terminalId, seq: "7", width: 80, height: 24, full: true, index: 0, count: 44, data: "" },
    })).toThrow(ProtocolError);
  });
});

describe("pairing device labels", () => {
  test("keeps labels valid, coarse, and within the daemon byte limit", () => {
    expect(normalizeDeviceLabel("  iPhone  ")).toBe("iPhone");
    expect(normalizeDeviceLabel("Mac\n<script>")).toBe("Mac<script>");
    expect(new TextEncoder().encode(normalizeDeviceLabel("手".repeat(100))).length).toBeLessThanOrEqual(120);
    expect(normalizeDeviceLabel(undefined)).toBe("浏览器设备");
  });
});

describe("rpc deadlines", () => {
  test("mutations wait as long as daemon executeRPC, including agent.start", () => {
    expect(MUTATION_RPC_TIMEOUT_MS).toBe(45_000);
    expect(READ_RPC_TIMEOUT_MS).toBe(8_000);
    expect(TERMINAL_RPC_TIMEOUT_MS).toBe(10_000);
    expect(TERMINAL_RPC_TIMEOUT_MS).toBeLessThan(MUTATION_RPC_TIMEOUT_MS);
    expect(MUTATION_RPC_TIMEOUT_MS).toBeGreaterThan(READ_RPC_TIMEOUT_MS);
  });
});

describe("mutation delivery outcome", () => {
  test("reconciles every uncertain post-send transport failure without replay", async () => {
    for (const code of ["timeout", "disconnected", "heartbeat_timeout", "daemon_replaced"]) {
      let sends = 0;
      const error = await trackMutationDelivery(async (markSent) => {
        sends++;
        markSent();
        throw new ProtocolError(code, code);
      }).catch((caught) => caught);

      expect(sends).toBe(1);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("unknown_outcome");

      const reads: string[] = [];
      expect(await reconcileMutationFailure(error, {
        snapshot: async () => { reads.push("Snapshot"); },
      })).toBeTrue();
      expect(reads).toEqual(["Snapshot"]);
    }
  });

  test("preserves disconnected as not-sent when delivery never started", async () => {
    const original = new ProtocolError("disconnected", "本次操作未发送");
    let sends = 0;
    const error = await trackMutationDelivery(async () => {
      sends++;
      throw original;
    }).catch((caught) => caught);

    expect(sends).toBe(1);
    expect(error).toBe(original);
    const reads: string[] = [];
    expect(await reconcileMutationFailure(error, {
      snapshot: async () => { reads.push("Snapshot"); },
    })).toBeFalse();
    expect(reads).toEqual([]);
  });
});
