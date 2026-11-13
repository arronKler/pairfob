/** Browser fixture: real DeviceHello/AEAD, an in-memory peer, synthetic delays. */
import { x25519 } from "@noble/curves/ed25519.js";
import vectors from "../../proto/pairfob-vectors.json";
import { SessionSocket, socketPair } from "../test-support/session-socket-fixture";
import { hexToBytes } from "../src/lib/protocol/bytes";
import { decode, encode, parseJSON, Typ, type Frame } from "../src/lib/protocol/envelope";
import { connectSession } from "../src/lib/protocol/session-connect";
import { createSessionCrypto, legacySessionCrypto } from "../src/lib/protocol/session-crypto";
import { sessionKeys } from "../src/lib/protocol/kdf";

const message = hexToBytes(vectors.hello_td), signature = hexToBytes(vectors.sig_d);
const pk = hexToBytes(vectors.ed25519_pk), psk = hexToBytes(vectors.device_psk);
const peerSecret = hexToBytes(vectors.eph_d_sk), peerPublic = x25519.getPublicKey(peerSecret);

export async function cryptoSample(native: boolean) {
  const started = performance.now();
  const crypto = native ? await createSessionCrypto() : legacySessionCrypto();
  try {
    const [valid, shared] = native
      ? await Promise.all([crypto.verify(pk, message, signature), crypto.sharedSecret(peerPublic)])
      : [await crypto.verify(pk, message, signature), await crypto.sharedSecret(peerPublic)];
    if (!valid) throw new Error("frozen signature rejected");
    const keys = sessionKeys(shared, psk);
    shared.fill(0);
    const elapsed = performance.now() - started;
    // Outside timing, check the independently derived daemon-side result too.
    const expected = sessionKeys(x25519.getSharedSecret(peerSecret, crypto.publicKey), psk);
    if (!keys.c2s.every((value, index) => value === expected.c2s[index])) throw new Error("DH mismatch");
    return elapsed;
  } finally { crypto.dispose(); }
}

export async function connectionSample({ openMs = 0, rttMs = 0 } = {}) {
  const original = globalThis.WebSocket;
  let peerCPU = 0;
  const sent: Frame[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  class DelayedSocket extends SessionSocket {
    override dispatchEvent(event: Event): boolean {
      const delay = event.type === "open" ? openMs : event.type === "message" ? rttMs / 2 : 0;
      if (!delay) return super.dispatchEvent(event);
      later(() => { super.dispatchEvent(event); }, delay);
      return true;
    }
    override send(data: Uint8Array): void {
      sent.push(decode(data));
      const receive = () => {
        const start = performance.now();
        super.send(data);
        peerCPU += performance.now() - start;
      };
      if (rttMs) later(receive, rttMs / 2);
      else receive();
    }
  }
  SessionSocket.instances = []; SessionSocket.log = []; SessionSocket.hold = "none"; SessionSocket.script = {};
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: DelayedSocket });
  let close: (() => void) | undefined;
  try {
    const started = performance.now();
    const connection = await connectSession("wss://pairfob.test/v2/ws", socketPair, () => undefined,
      undefined, undefined, undefined, { reads: [{ op: "GetConfig", params: {} }, { op: "Snapshot", params: { session: null } }] });
    close = () => connection.transport.close();
    await Promise.all(connection.reads.map((read) => read.answer));
    const elapsed = performance.now() - started;
    const socket = SessionSocket.instances[0]!;
    return {
      elapsed, peerCPU, sockets: SessionSocket.instances.length,
      clientFrames: sent.length, clientBytes: sent.reduce((sum, frame) => sum + encode(frame).length, 0),
      hellos: sent.filter((frame) => frame.typ === Typ.FWD && frame.payload[0] === 123 && parseJSON(frame).op === "DeviceHello1").length,
      rpcs: socket.operations,
    };
  } finally {
    close?.();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of SessionSocket.instances) socket.finishClose();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
  }
}
