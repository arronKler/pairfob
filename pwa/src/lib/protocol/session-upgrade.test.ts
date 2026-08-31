import { describe, expect, test } from "bun:test";
import { Direction, DIR_C, DIR_S } from "./aead.ts";
import { decodeUTF8, Typ, type Frame } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel } from "./frame-channel.ts";
import { commitDirectSession, type PreparedDirectSession } from "./session-upgrade.ts";
import { SessionTransport } from "./session-transport.ts";

class DirectLoopback implements FrameChannel {
  readonly kind = "p2p" as const;
  private handler: ((frame: Frame) => void) | null = null;
  private closeHandlers = new Set<(error: ProtocolError) => void>();
  private readonly fromClient: Direction;
  private readonly toClient: Direction;

  constructor(private readonly routeId: Uint8Array, c2sKey: Uint8Array, s2cKey: Uint8Array) {
    this.fromClient = new Direction(c2sKey, DIR_C);
    this.toClient = new Direction(s2cKey, DIR_S);
  }

  send(frame: Frame): void {
    if (frame.typ === Typ.PING) {
      queueMicrotask(() => this.handler?.({ ...frame, typ: Typ.PONG }));
      return;
    }
    const request = JSON.parse(decodeUTF8(this.fromClient.open(this.routeId, frame.payload))) as { id: string };
    const body = new TextEncoder().encode(JSON.stringify({ v: 1, id: request.id, ok: true, result: { pong: true } }));
    const payload = this.toClient.seal(this.routeId, body);
    queueMicrotask(() => this.handler?.({ version: 1, typ: Typ.FWD, flags: 0, routeId: this.routeId, payload }));
  }

  close(): void {
    for (const handler of this.closeHandlers) handler(new ProtocolError("closed", "closed"));
  }

  next(): Promise<Frame> { return Promise.reject(new Error("unused")); }
  use(handler: (frame: Frame) => void): void { this.handler = handler; }
  onClose(handler: (error: ProtocolError) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
}

function directCandidate(): PreparedDirectSession {
  const routeId = new Uint8Array(16);
  routeId[0] = 7;
  const c2sKey = new Uint8Array(32).fill(3);
  const s2cKey = new Uint8Array(32).fill(5);
  const channel = new DirectLoopback(routeId, c2sKey.slice(), s2cKey.slice());
  return {
    attemptId: "p2p_0123456789abcdef",
    channel,
    epoch: {
      routeId,
      c2s: new Direction(c2sKey, DIR_C),
      s2c: new Direction(s2cKey, DIR_S),
    },
    close: () => channel.close(),
  };
}

describe("atomic direct commit", () => {
  test("commits once and proves the new encrypted route", async () => {
    const calls: string[] = [];
    const relay = {
      kind: "relay",
      rpc: async (op: string, params: unknown) => {
        calls.push(op);
        const request = params as { attempt_id: string; route_id: string };
        return { attempt_id: request.attempt_id, route_id: request.route_id, transport: "webrtc" };
      },
    } as unknown as SessionTransport;
    const result = await commitDirectSession(relay, directCandidate(), () => undefined);
    expect(calls).toEqual(["TransportCommit"]);
    expect(result.transport.kind).toBe("p2p");
    expect(result.rttMs).toBeGreaterThanOrEqual(0);
    result.transport.close();
  });

  test("an uncertain relay reply is resolved by probing direct without replaying commit", async () => {
    let calls = 0;
    const relay = {
      kind: "relay",
      rpc: async () => {
        calls++;
        throw new ProtocolError("timeout", "reply lost");
      },
    } as unknown as SessionTransport;
    const result = await commitDirectSession(relay, directCandidate(), () => undefined);
    expect(calls).toBe(1);
    expect(result.transport.kind).toBe("p2p");
    result.transport.close();
  });

  test("rejects a non-exact commit acknowledgment", async () => {
    const relay = {
      kind: "relay",
      rpc: async () => ({ attempt_id: "p2p_0123456789abcdef", route_id: "00".repeat(16), transport: "webrtc", extra: true }),
    } as unknown as SessionTransport;
    const error = await commitDirectSession(relay, directCandidate(), () => undefined).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("bad_message");
  });
});
