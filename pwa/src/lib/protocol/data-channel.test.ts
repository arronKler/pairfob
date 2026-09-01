import { describe, expect, test } from "bun:test";
import { DataFrameChannel } from "./data-channel.ts";
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
  send(): void {}
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
