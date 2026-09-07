import { describe, expect, test } from "bun:test";
import { Direction, DIR_C, DIR_S } from "./aead.ts";
import { DataFrameChannel } from "./data-channel.ts";
import { DirectFrameAssembler } from "./direct-frame.ts";
import { decode, Typ, type Frame } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel, FrameChannelKind } from "./frame-channel.ts";
import { heartbeatPayload } from "./frame-socket.ts";
import { SessionTransport } from "./session-transport.ts";
import { trackMutationDelivery } from "./session-ws.ts";

class MockChannel implements FrameChannel {
  readonly kind: FrameChannelKind;
  sent: Frame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  failNext: ProtocolError | null = null;
  failFwd: ProtocolError | null = null;
  handler: ((frame: Frame) => void) | null = null;
  private readonly closeHandlers = new Set<(error: ProtocolError) => void>();

  constructor(kind: FrameChannelKind = "p2p") {
    this.kind = kind;
  }

  send(frame: Frame): void {
    if (this.closed) throw new ProtocolError("disconnected", "连接已断开");
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (frame.typ === Typ.FWD && this.failFwd) {
      const error = this.failFwd;
      this.failFwd = null;
      throw error;
    }
    this.sent.push(frame);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const handler of this.closeHandlers) handler(new ProtocolError("disconnected", "连接已断开"));
  }

  next(): Promise<Frame> {
    return Promise.reject(new ProtocolError("disconnected", "unused"));
  }

  use(handler: (frame: Frame) => void): void {
    this.handler = handler;
  }

  onClose(handler: (error: ProtocolError) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  deliver(frame: Frame): void {
    this.handler?.(frame);
  }

  fwd(): Frame[] {
    return this.sent.filter((frame) => frame.typ === Typ.FWD);
  }
}

class FakeTarget {
  protected listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type } as Event);
  }
}

class ProbeChannel extends FakeTarget {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  sent: ArrayBuffer[] = [];

  send(data: ArrayBuffer): void {
    this.sent.push(data.slice(0));
  }

  close(): void {
    this.readyState = "closed";
    this.emit("close");
  }
}

class ProbePeer extends FakeTarget {
  iceConnectionState: RTCIceConnectionState = "connected";
  connectionState: RTCPeerConnectionState = "connected";
  close(): void {
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
  }
}

function keys(): { c2s: Direction; s2c: Direction; route: Uint8Array } {
  const key = new Uint8Array(32).fill(7);
  return {
    c2s: new Direction(key, DIR_C),
    s2c: new Direction(key, DIR_S),
    route: new Uint8Array(16).fill(3),
  };
}

function openTransport(channel: MockChannel, c2s: Direction, s2c: Direction, route: Uint8Array): SessionTransport {
  return new SessionTransport(channel, route, c2s, s2c, () => {});
}

describe("SessionTransport post-seal send failure", () => {
  test("capacity rejection fails the epoch and does not send after the buffer drains", async () => {
    const { c2s, s2c, route } = keys();
    const channel = new MockChannel();
    const transport = openTransport(channel, c2s, s2c, route);
    const disconnects: string[] = [];
    transport.onDisconnect((error) => disconnects.push(error.code));
    channel.failFwd = new ProtocolError("backpressure", "P2P 发送队列已满");

    const error = await transport.rpc("Snapshot", {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("backpressure");
    expect(c2s.seq).toBe(1n);
    expect(channel.fwd()).toEqual([]);
    expect(channel.closed).toEqual({ code: 1011, reason: "send failed" });
    expect(disconnects).toEqual(["disconnected"]);

    channel.failFwd = null;
    const drained = await transport.rpc("Ping", { t_ms: 1 }).catch((caught) => caught);
    expect(drained).toBeInstanceOf(ProtocolError);
    expect((drained as ProtocolError).code).toBe("disconnected");
    expect(c2s.seq).toBe(1n);
    expect(channel.fwd()).toEqual([]);
    transport.close();
  });

  test("a sealed-but-unsent mutation stays not-sent; an already-sent mutation becomes unknown_outcome", async () => {
    const { c2s, s2c, route } = keys();
    const channel = new MockChannel();
    const transport = openTransport(channel, c2s, s2c, route);

    const first = trackMutationDelivery((markSent) => transport.rpc("SendText", { pane_id: "w0:p1", text: "x" }, 8_000, markSent));
    expect(channel.fwd()).toHaveLength(1);
    expect(c2s.seq).toBe(1n);

    channel.failFwd = new ProtocolError("backpressure", "P2P 发送队列已满");
    const second = await trackMutationDelivery((markSent) => transport.rpc("SendText", { pane_id: "w0:p1", text: "y" }, 8_000, markSent)).catch((caught) => caught);
    expect(second).toBeInstanceOf(ProtocolError);
    expect((second as ProtocolError).code).toBe("backpressure");

    const firstError = await first.catch((caught) => caught);
    expect(firstError).toBeInstanceOf(ProtocolError);
    expect((firstError as ProtocolError).code).toBe("unknown_outcome");
    expect(channel.fwd()).toHaveLength(1);
    transport.close();
  });

  test("sendResponse failure after seal fails the epoch instead of staying on a gapped sequence", async () => {
    const { c2s, s2c, route } = keys();
    const inbound = new Direction(new Uint8Array(32).fill(7), DIR_S);
    const channel = new MockChannel();
    const transport = openTransport(channel, c2s, s2c, route);
    const disconnects: string[] = [];
    transport.onDisconnect((error) => disconnects.push(error.code));

    const ping = inbound.seal(route, new TextEncoder().encode(JSON.stringify({
      v: 1, id: "ping_1", op: "Ping", params: { t_ms: 7 },
    })));
    channel.failFwd = new ProtocolError("backpressure", "P2P 发送队列已满");
    channel.deliver({ version: 1, typ: Typ.FWD, flags: 0, routeId: route, payload: ping });

    expect(c2s.seq).toBe(1n);
    expect(channel.fwd()).toEqual([]);
    expect(channel.closed).toEqual({ code: 1011, reason: "send failed" });
    expect(disconnects).toEqual(["disconnected"]);
    const later = await transport.rpc("Ping", { t_ms: 1 }).catch((caught) => caught);
    expect((later as ProtocolError).code).toBe("disconnected");
    expect(c2s.seq).toBe(1n);
    transport.close();
  });

  test("relay send failure after seal also closes the epoch", async () => {
    const { c2s, s2c, route } = keys();
    const channel = new MockChannel("relay");
    const transport = openTransport(channel, c2s, s2c, route);
    channel.failFwd = new ProtocolError("disconnected", "连接已断开");
    const error = await transport.rpc("Snapshot", {}).catch((caught) => caught);
    expect((error as ProtocolError).code).toBe("disconnected");
    expect(channel.closed?.code).toBe(1011);
    expect(c2s.seq).toBe(1n);
    transport.close();
  });
});

describe("DataFrameChannel queue-full through SessionTransport", () => {
  test("a full 2 MiB buffer fails the epoch; draining it cannot reuse the gapped sender", async () => {
    const peer = new ProbePeer();
    const rtc = new ProbeChannel();
    const adapter = new DataFrameChannel(rtc as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection);
    const key = new Uint8Array(32).fill(7);
    const route = new Uint8Array(16).fill(3);
    const sender = new Direction(key, DIR_C);
    const receiver = new Direction(key, DIR_C);
    const transport = new SessionTransport(adapter, route, sender, new Direction(key, DIR_S), () => {});
    const disconnects: string[] = [];
    transport.onDisconnect((error) => disconnects.push(error.code));
    rtc.sent = [];
    rtc.bufferedAmount = 2 * 1024 * 1024;

    const rejected = await transport.rpc("Snapshot", {}).catch((caught) => caught as ProtocolError);
    expect(rejected).toBeInstanceOf(ProtocolError);
    expect(["backpressure", "disconnected"]).toContain(rejected.code);
    expect(sender.seq).toBe(1n);
    expect(rtc.readyState).toBe("closed");
    expect(disconnects).toContain("disconnected");

    rtc.bufferedAmount = 0;
    const pending = transport.rpc("Ping", { t_ms: 1 }).catch((caught) => (caught as ProtocolError).code);
    const assembler = new DirectFrameAssembler();
    let nextMessageError = "";
    for (const bytes of rtc.sent) {
      const joined = assembler.push(new Uint8Array(bytes));
      if (!joined) continue;
      const frame = decode(joined);
      if (frame.typ !== Typ.FWD) continue;
      try {
        receiver.open(route, frame.payload);
      } catch (error) {
        nextMessageError = (error as Error).message;
      }
    }
    expect(await pending).toBe("disconnected");
    expect(nextMessageError).toBe("");
    expect(sender.seq).toBe(1n);
    transport.close();
  });
});

describe("heartbeat payload helper still matches the transport", () => {
  test("constructor emits an envelope PING, not an AEAD FWD", () => {
    const { c2s, s2c, route } = keys();
    const channel = new MockChannel();
    const transport = openTransport(channel, c2s, s2c, route);
    expect(channel.sent[0]?.typ).toBe(Typ.PING);
    expect([...channel.sent[0]!.payload]).toEqual([...heartbeatPayload(1n)]);
    expect(c2s.seq).toBe(0n);
    transport.close();
  });
});
