import { x25519 } from "@noble/curves/ed25519.js";
import { Direction, DIR_C, DIR_S } from "./aead.ts";
import { b64url, bytesToHex } from "./bytes.ts";
import { jsonFrame, parseJSON, Typ, type Frame } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel } from "./frame-channel.ts";
import { envelopeError, parseExactB64, requireHeartbeatPayload, sameBytes, Z16 } from "./frame-socket.ts";
import { fingerprint16, proof, transcriptD, transcriptP, verifyEd25519 } from "./hello.ts";
import { sessionKeys } from "./kdf.ts";
import type { MuxProtocol } from "./mux.ts";
import type { PairResult } from "./pair-ws.ts";

export type SessionEpoch = {
  routeId: Uint8Array;
  c2s: Direction;
  s2c: Direction;
};

export type HandshakeStage = "route_bound" | "hello_verified" | "session_established";

/**
 * A DeviceHello exchange paused between its two flights. Until `finish` sends
 * DeviceHello3 the computer keeps the device's established route, so a pending
 * handshake can be abandoned without disturbing a live session.
 */
export type SessionHello = {
  /** DeviceHello2 has been verified against the stored credential. */
  verified: Promise<void>;
  /**
   * Send DeviceHello3 and wait for SESSION_ESTABLISHED. `behind` runs right
   * after DeviceHello3 leaves and may send frames sealed on the new epoch: the
   * computer handles them in order, after it has established the route.
   */
  finish(behind?: (epoch: SessionEpoch) => void): Promise<SessionEpoch>;
};

/**
 * Send DeviceHello1 and verify DeviceHello2. `routeId` is null on a relay
 * socket whose SESSION_ATTACH has just been sent: the relay stamps the bound
 * route on every phone FWD, so DeviceHello1 rides ahead of SESSION_BOUND.
 */
export function beginSessionEpoch(
  channel: FrameChannel,
  routeId: Uint8Array | null,
  pair: PairResult,
  protocol: MuxProtocol,
  observe?: (stage: HandshakeStage) => void,
): SessionHello {
  const ephemeralSecret = x25519.utils.randomPrivateKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  channel.send(jsonFrame(Typ.FWD, routeId ?? Z16, {
    v: 1,
    op: "DeviceHello1",
    device_id: pair.deviceId,
    daemon_id: pair.daemonId,
    eph_x25519: b64url(ephemeralPublic),
    nonce: b64url(nonce),
  }));

  const hello2 = (async () => {
    const route = routeId ?? await awaitSessionBound(channel);
    if (!routeId) observe?.("route_bound");
    const helloFrame = await channel.next(8_000);
    if (helloFrame.typ === Typ.ERROR) throw envelopeError(helloFrame);
    if (helloFrame.typ !== Typ.FWD || !sameBytes(helloFrame.routeId, route)) {
      throw new ProtocolError("bad_message", "DeviceHello2 信封错误");
    }
    const hello = parseJSON(helloFrame);
    if (hello.op !== "DeviceHello2" || !hello.ok) {
      throw new ProtocolError(String(hello.error?.code || "unpaired"), "DeviceHello2 拒绝凭证");
    }
    const ephemeralDaemon = parseExactB64(hello.eph_x25519, 32, "eph_x25519");
    const proofDaemon = parseExactB64(hello.proof_d, 32, "proof_d");
    const signatureDaemon = parseExactB64(hello.sig_d, 64, "sig_d");
    if (!Number.isSafeInteger(hello.ts)) throw new ProtocolError("bad_message", "DeviceHello2 ts 错误");
    const transcript = transcriptD(
      pair.daemonId,
      pair.deviceId,
      ephemeralPublic,
      ephemeralDaemon,
      nonce,
      BigInt(hello.ts),
      route,
    );
    if (!sameBytes(proof(pair.psk, transcript), proofDaemon)) throw new ProtocolError("bad_proof", "daemon PSK 证明失败");
    if (!verifyEd25519(pair.daemonPk, transcript, signatureDaemon)) throw new ProtocolError("bad_signature", "daemon 签名失败");
    observe?.("hello_verified");
    return { route, transcript, ephemeralDaemon };
  })();
  const verified = hello2.then(() => undefined);
  // A paused handshake may be abandoned before anyone awaits it.
  verified.catch(() => undefined);

  return {
    verified,
    finish: async (behind) => {
      const { route, transcript, ephemeralDaemon } = await hello2;
      channel.send(jsonFrame(Typ.FWD, route, {
        v: 1,
        op: "DeviceHello3",
        proof_p: b64url(proof(pair.psk, transcriptP(transcript))),
      }));
      const keys = sessionKeys(x25519.getSharedSecret(ephemeralSecret, ephemeralDaemon), pair.psk);
      const epoch = { routeId: route, c2s: new Direction(keys.c2s, DIR_C), s2c: new Direction(keys.s2c, DIR_S) };
      behind?.(epoch);
      await waitSessionEstablished(channel, route, protocol);
      observe?.("session_established");
      return epoch;
    },
  };
}

/** Authenticate a fresh route and derive a transport-specific AEAD key epoch. */
export async function establishSessionEpoch(
  channel: FrameChannel,
  routeId: Uint8Array,
  pair: PairResult,
  protocol: MuxProtocol,
  observe?: (stage: HandshakeStage) => void,
): Promise<SessionEpoch> {
  return beginSessionEpoch(channel, routeId, pair, protocol, observe).finish();
}

/** The relay's answer to SESSION_ATTACH: the route this socket now speaks on. */
export async function awaitSessionBound(channel: FrameChannel): Promise<Uint8Array> {
  const bound = await channel.next(8_000);
  if (bound.typ === Typ.ERROR) throw envelopeError(bound);
  if (bound.typ !== Typ.SESSION_BOUND) throw new ProtocolError("bad_message", `预期 SESSION_BOUND，实际 ${bound.typ}`);
  return bound.routeId;
}

async function waitSessionEstablished(channel: FrameChannel, routeId: Uint8Array, protocol: MuxProtocol): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = await channel.next(Math.max(1, deadline - Date.now()));
    if (frame.typ === Typ.PING) {
      requireHeartbeatPayload(frame.payload);
      channel.send({ ...frame, typ: Typ.PONG });
      continue;
    }
    if (frame.typ === Typ.PONG) {
      requireHeartbeatPayload(frame.payload);
      continue;
    }
    if (frame.typ === Typ.ERROR) throw envelopeError(frame);
    if (frame.typ === Typ.DAEMON_REPLACED) throw new ProtocolError("daemon_replaced", "daemon 在握手期间重连");
    if (frame.typ === Typ.FWD && sameBytes(frame.routeId, routeId)) {
      try {
        const hello = parseJSON(frame);
        if (hello.op === "DeviceHello2" && !hello.ok) {
          throw new ProtocolError(String(hello.error?.code || "unpaired"), "DeviceHello3 被拒绝");
        }
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
      }
      throw new ProtocolError("bad_message", "建立会话前收到意外 FWD");
    }
    if (frame.typ !== Typ.SESSION_ESTABLISHED) {
      throw new ProtocolError("bad_message", `建立会话前收到意外控制帧 ${frame.typ}`);
    }
    validateSessionEstablished(frame, routeId, protocol);
    return;
  }
  throw new ProtocolError("timeout", "等待 SESSION_ESTABLISHED 超时");
}

export function validateSessionEstablished(frame: Frame, routeId: Uint8Array, protocol: MuxProtocol = 1): void {
  if (frame.typ !== Typ.SESSION_ESTABLISHED || !sameBytes(frame.routeId, routeId)) {
    throw new ProtocolError("bad_message", "SESSION_ESTABLISHED 信封不匹配");
  }
  const body = parseJSON(frame);
  if (body.v !== protocol || body.route_id !== bytesToHex(routeId)) {
    throw new ProtocolError("bad_message", "SESSION_ESTABLISHED route_id 不匹配");
  }
}
