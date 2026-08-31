import { x25519 } from "@noble/curves/ed25519.js";
import { Direction, DIR_C, DIR_S } from "./aead.ts";
import { b64url, bytesToHex } from "./bytes.ts";
import { jsonFrame, parseJSON, Typ, type Frame } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel } from "./frame-channel.ts";
import { envelopeError, parseExactB64, requireHeartbeatPayload, sameBytes } from "./frame-socket.ts";
import { fingerprint16, proof, transcriptD, transcriptP, verifyEd25519 } from "./hello.ts";
import { sessionKeys } from "./kdf.ts";
import type { MuxProtocol } from "./mux.ts";
import type { PairResult } from "./pair-ws.ts";

export type SessionEpoch = {
  routeId: Uint8Array;
  c2s: Direction;
  s2c: Direction;
};

/** Authenticate a fresh route and derive a transport-specific AEAD key epoch. */
export async function establishSessionEpoch(
  channel: FrameChannel,
  routeId: Uint8Array,
  pair: PairResult,
  protocol: MuxProtocol,
): Promise<SessionEpoch> {
  const ephemeralSecret = x25519.utils.randomPrivateKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  channel.send(jsonFrame(Typ.FWD, routeId, {
    v: 1,
    op: "DeviceHello1",
    device_id: pair.deviceId,
    daemon_id: pair.daemonId,
    eph_x25519: b64url(ephemeralPublic),
    nonce: b64url(nonce),
  }));

  const helloFrame = await channel.next(8_000);
  if (helloFrame.typ === Typ.ERROR) throw envelopeError(helloFrame);
  if (helloFrame.typ !== Typ.FWD || !sameBytes(helloFrame.routeId, routeId)) {
    throw new ProtocolError("bad_message", "DeviceHello2 信封错误");
  }
  const hello2 = parseJSON(helloFrame);
  if (hello2.op !== "DeviceHello2" || !hello2.ok) {
    throw new ProtocolError(String(hello2.error?.code || "unpaired"), "DeviceHello2 拒绝凭证");
  }
  const ephemeralDaemon = parseExactB64(hello2.eph_x25519, 32, "eph_x25519");
  const proofDaemon = parseExactB64(hello2.proof_d, 32, "proof_d");
  const signatureDaemon = parseExactB64(hello2.sig_d, 64, "sig_d");
  if (!Number.isSafeInteger(hello2.ts)) throw new ProtocolError("bad_message", "DeviceHello2 ts 错误");
  const transcript = transcriptD(
    pair.daemonId,
    pair.deviceId,
    ephemeralPublic,
    ephemeralDaemon,
    nonce,
    BigInt(hello2.ts),
    routeId,
  );
  if (!sameBytes(proof(pair.psk, transcript), proofDaemon)) throw new ProtocolError("bad_proof", "daemon PSK 证明失败");
  if (!verifyEd25519(pair.daemonPk, transcript, signatureDaemon)) throw new ProtocolError("bad_signature", "daemon 签名失败");
  channel.send(jsonFrame(Typ.FWD, routeId, {
    v: 1,
    op: "DeviceHello3",
    proof_p: b64url(proof(pair.psk, transcriptP(transcript))),
  }));
  const keys = sessionKeys(x25519.getSharedSecret(ephemeralSecret, ephemeralDaemon), pair.psk);
  await waitSessionEstablished(channel, routeId, protocol);
  return {
    routeId,
    c2s: new Direction(keys.c2s, DIR_C),
    s2c: new Direction(keys.s2c, DIR_S),
  };
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
