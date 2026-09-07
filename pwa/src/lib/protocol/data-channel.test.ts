import { describe, expect, test } from "bun:test";
import { DataFrameChannel } from "./data-channel.ts";
import { jsonFrame, Typ } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";

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

class FakeChannel extends FakeTarget {
  binaryType = "arraybuffer";
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  sent = 0;
  failAfter = 0;
  send(): void {
    this.sent += 1;
    if (this.failAfter > 0 && this.sent >= this.failAfter) throw new Error("send failed");
  }
  close(): void {
    this.readyState = "closed";
    this.emit("close");
  }
}

class FakePeer extends FakeTarget {
  iceConnectionState: RTCIceConnectionState = "connected";
  connectionState: RTCPeerConnectionState = "connected";
  close(): void {
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
  }

  setIce(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.emit("iceconnectionstatechange");
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("P2P ICE health on the DataChannel", () => {
  test("a brief disconnected flap does not close the channel", async () => {
    const peer = new FakePeer();
    const channel = new FakeChannel();
    const link = new DataFrameChannel(channel as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection, { iceGraceMs: 30 });
    let closed = 0;
    link.onClose(() => { closed += 1; });
    peer.setIce("disconnected");
    peer.setIce("connected");
    await wait(50);
    expect(closed).toBe(0);
    expect(link.iceHealthy()).toBeTrue();
  });

  test("disconnected past the grace window notifies without immediately failing when watched", async () => {
    const peer = new FakePeer();
    const channel = new FakeChannel();
    const link = new DataFrameChannel(channel as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection, { iceGraceMs: 20 });
    let unhealthy = 0;
    let closed = 0;
    link.onIceUnhealthy(() => { unhealthy += 1; });
    link.onClose(() => { closed += 1; });
    peer.setIce("disconnected");
    await wait(40);
    expect(unhealthy).toBe(1);
    expect(closed).toBe(0);
  });

  test("ICE failed closes the channel immediately", async () => {
    const peer = new FakePeer();
    const channel = new FakeChannel();
    const link = new DataFrameChannel(channel as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection, { iceGraceMs: 200 });
    const closed = new Promise<ProtocolError>((resolve) => link.onClose(resolve));
    peer.setIce("failed");
    const error = await closed;
    expect(error.code).toBe("disconnected");
  });
});

describe("P2P send queue backpressure", () => {
  test("a full buffer rejects send and closes so a later drain cannot reuse the channel", () => {
    const peer = new FakePeer();
    const channel = new FakeChannel();
    const link = new DataFrameChannel(channel as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection);
    const closed: string[] = [];
    link.onClose((error) => closed.push(error.code));
    channel.bufferedAmount = 2 * 1024 * 1024;
    const frame = jsonFrame(Typ.PING, new Uint8Array(16), {});
    try {
      link.send(frame);
      throw new Error("send should have rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("backpressure");
    }
    expect(closed).toEqual(["disconnected"]);
    expect(channel.readyState).toBe("closed");
    channel.bufferedAmount = 0;
    expect(() => link.send(frame)).toThrow(ProtocolError);
    expect(channel.sent).toBe(0);
  });

  test("a partial chunk send closes the channel", () => {
    const peer = new FakePeer();
    const channel = new FakeChannel();
    channel.failAfter = 2;
    const link = new DataFrameChannel(channel as unknown as RTCDataChannel, peer as unknown as RTCPeerConnection);
    const closed: string[] = [];
    link.onClose((error) => closed.push(error.code));
    const frame = jsonFrame(Typ.FWD, new Uint8Array(16), { pad: "x".repeat(20_000) });
    expect(() => link.send(frame)).toThrow("send failed");
    expect(closed).toEqual(["disconnected"]);
    expect(channel.readyState).toBe("closed");
  });
});
