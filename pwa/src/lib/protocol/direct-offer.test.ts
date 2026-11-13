import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDirectOffer, MAX_SDP_BYTES } from "./direct-peer";

const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n";
class Channel extends EventTarget {
  readyState = "connecting";
  closed = false;
  binaryType = "arraybuffer";
  close() { this.closed = true; this.readyState = "closed"; }
}
class Peer extends EventTarget {
  static instances: Peer[] = [];
  static offerGate: Promise<RTCSessionDescriptionInit> | undefined;
  localDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState = "complete";
  iceConnectionState = "new";
  connectionState = "new";
  readonly channel = new Channel();
  closed = false;
  constructor() { super(); Peer.instances.push(this); }
  createDataChannel() { return this.channel; }
  async createOffer() { return Peer.offerGate ?? { type: "offer" as const, sdp }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription() {}
  close() { this.closed = true; }
}
let original: typeof RTCPeerConnection;
beforeEach(() => {
  original = globalThis.RTCPeerConnection;
  Peer.instances = []; Peer.offerGate = undefined;
  Object.defineProperty(globalThis, "RTCPeerConnection", { value: Peer, configurable: true, writable: true });
});
afterEach(() => Object.defineProperty(globalThis, "RTCPeerConnection", { value: original, configurable: true, writable: true }));

test("a prepared offer uses candidates that arrived while relay authentication was pending", async () => {
  const offer = await createDirectOffer();
  const peer = Peer.instances[0]!;
  const later = sdp + "a=candidate:2 1 UDP 1 192.0.2.2 5001 typ host\r\n";
  peer.localDescription = { type: "offer", sdp: later };
  expect(offer.sdp).toBe(later);
  peer.localDescription.sdp = "x".repeat(MAX_SDP_BYTES + 1);
  expect(() => offer.sdp).toThrow();
  offer.close();
  expect(peer.closed).toBe(true);
});

test("the upgrade's abort signal owns accept after ICE preparation is handed over", async () => {
  const preparation = new AbortController();
  const offer = await createDirectOffer(preparation.signal);
  const upgrade = new AbortController();
  const accepting = offer.accept({ attemptId: offer.attemptId, routeId: new Uint8Array(16), sdp }, upgrade.signal);
  upgrade.abort();
  await expect(accepting).rejects.toMatchObject({ diagnostic: "cancelled" });
  offer.close();
  expect(Peer.instances[0]!.closed).toBe(true);
});

test("cancellation closes native resources even while createOffer is still pending", async () => {
  let resolve!: (value: RTCSessionDescriptionInit) => void;
  Peer.offerGate = new Promise(yes => { resolve = yes; });
  const controller = new AbortController();
  const creating = createDirectOffer(controller.signal);
  controller.abort();
  expect(Peer.instances[0]!.closed).toBe(true);
  expect(Peer.instances[0]!.channel.closed).toBe(true);
  resolve({ type: "offer", sdp });
  await expect(creating).rejects.toMatchObject({ diagnostic: "cancelled" });
});
