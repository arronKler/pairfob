import { validDaemonId, validDeviceId } from "../identifiers.ts";
import { Direction, DIR_C, DIR_S } from "./aead.ts";
import { b64url, normalizeCrockford } from "./bytes.ts";
import { decodeUTF8, jsonFrame, parseJSON, Typ, type Frame } from "./envelope.ts";
import { fingerprint16, sas } from "./hello.ts";
import { pairingKeys } from "./kdf.ts";
import { deriveRecord, idProver, Prover } from "./spake.ts";
import { ProtocolError } from "./errors.ts";
import {
  envelopeError,
  FrameSocket,
  HEARTBEAT_MS,
  heartbeatPayload,
  openWS,
  parseExactB64,
  relayOrigin,
  requireHeartbeatPayload,
  sameBytes,
  send,
  Z16,
} from "./frame-socket.ts";
import {
  helloClientBody,
  muxProtocolFromRelayURL,
  muxSubprotocol,
  pairAttachBody,
  pairingWsUsesTicket,
  type MuxProtocol,
} from "./mux.ts";

export interface PairResult {
  deviceId: string;
  psk: Uint8Array;
  daemonPk: Uint8Array;
  daemonId: string;
  fp: string;
  relayOrigin: string;
  label: string;
  createdAt: number;
  hostname?: string;
  lastSeen?: number;
}

export interface PairInput {
  pair_ref?: string;
}

export interface PairOptions {
  onAwaitApproval?: () => void;
  signal?: AbortSignal;
  expectedDaemonId?: string;
  expectedFingerprint?: string;
  label?: string;
  protocol?: MuxProtocol;
}

export function normalizeDeviceLabel(raw: string | undefined): string {
  const fallback = "浏览器设备";
  const trimmed = (raw || fallback).trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, "") || fallback;
  const encoder = new TextEncoder();
  if (encoder.encode(trimmed).length <= 120) return trimmed;
  let result = "";
  for (const rune of trimmed) {
    if (encoder.encode(result + rune).length > 120) break;
    result += rune;
  }
  return result || fallback;
}

/** Normalize the one operator-visible code before opening any relay socket. */
export function normalizePairInput(input: PairInput, code: string): { input: PairInput; code: string } {
  const normalizedCode = normalizeCrockford(code);
  if (normalizedCode.length !== 8 || !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalizedCode)) {
    throw new ProtocolError("invalid_pair_code", "配对码必须是 8 位 Crockford 字符");
  }
  const ref = input.pair_ref?.trim().toLowerCase();
  if (ref && !/^[0-9a-f]{32}$/.test(ref)) {
    throw new ProtocolError("invalid_pair_ref", "二维码中的 pair_ref 格式错误");
  }
  return { input: { pair_ref: ref }, code: normalizedCode };
}

export function confirmationTagMatches(localTag: string, remoteTag: unknown): boolean {
  return localTag.length > 0 && localTag === remoteTag;
}

function pairingCancelled(): ProtocolError {
  return new ProtocolError("pairing_cancelled", "已取消配对");
}

async function receivePairOp(socket: FrameSocket, routeId: Uint8Array, op: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await socket.next(Math.max(1, deadline - Date.now()));
    if (frame.typ === Typ.PING) {
      requireHeartbeatPayload(frame.payload);
      send(socket.ws, { ...frame, typ: Typ.PONG });
      continue;
    }
    if (frame.typ === Typ.PONG) {
      requireHeartbeatPayload(frame.payload);
      continue;
    }
    if (frame.typ === Typ.ERROR) throw envelopeError(frame);
    if (frame.typ !== Typ.FWD) throw new ProtocolError("bad_frame", `配对期间收到意外控制帧 ${frame.typ}`);
    if (!sameBytes(frame.routeId, routeId)) throw new ProtocolError("bad_frame", "配对 FWD route_id 不匹配");
    const message = parseJSON(frame);
    if (message.op === op) return message;
  }
  throw new ProtocolError("timeout", `等待 ${op} 超时`);
}

function isPreAttachFailure(error: unknown): boolean {
  if (!(error instanceof ProtocolError)) return true;
  return ["disconnected", "timeout", "ws_open_failed", "wrong_protocol"].includes(error.code);
}

export async function pairOverWS(
  relayWS: string,
  rawInput: PairInput,
  rawCode: string,
  options: PairOptions,
): Promise<PairResult> {
  const normalized = normalizePairInput(rawInput, rawCode);
  const label = normalizeDeviceLabel(options.label);
  const origin = relayOrigin(relayWS);
  const protocol = options.protocol ?? muxProtocolFromRelayURL(relayWS);
  let socket: FrameSocket | null = null;
  let pairHeartbeat: ReturnType<typeof setInterval> | null = null;
  let attachedReceived = false;
  try {
    if (protocol === 2 && !normalized.input.pair_ref) {
      throw new ProtocolError("invalid_pair_ref", "v2 PAIR_ATTACH 必须带 pair_ref");
    }
    socket = await openWS(relayWS, muxSubprotocol(protocol), options.signal);
    send(socket.ws, jsonFrame(Typ.HELLO_CLIENT, Z16, helloClientBody(protocol)));
    send(socket.ws, jsonFrame(Typ.PAIR_ATTACH, Z16, pairAttachBody(protocol, normalized.input.pair_ref)));
    const attached = await socket.next(8_000);
    if (attached.typ === Typ.ERROR) {
      const error = envelopeError(attached);
      if (error.code === "unpaired") throw new ProtocolError("unpaired", "配对码过期或已用过，请抄电脑 pairfob 打印的当前码");
      throw error;
    }
    if (attached.typ !== Typ.PAIR_ATTACHED) throw new ProtocolError("bad_message", `预期 PAIR_ATTACHED，实际 ${attached.typ}`);
    attachedReceived = true;
    const detail = parseJSON(attached);
    const routeId = attached.routeId;
    let heartbeatCounter = 0n;
    pairHeartbeat = globalThis.setInterval(() => {
      try {
        send(socket!.ws, { version: 1, typ: Typ.PING, flags: 0, routeId, payload: heartbeatPayload(++heartbeatCounter) });
      } catch {
        // The main receive path reports the closed socket with its exact cause.
      }
    }, HEARTBEAT_MS);
    const daemonId = typeof detail.daemon_id === "string" ? detail.daemon_id : "";
    const pairRef = normalized.input.pair_ref || (typeof detail.pair_ref === "string" ? detail.pair_ref.toLowerCase() : "");
    if (!validDaemonId(daemonId) || !/^[0-9a-f]{32}$/.test(pairRef)) throw new ProtocolError("bad_message", "PAIR_ATTACHED 的 daemon_id 或 pair_ref 非法");
    if (options.expectedDaemonId && options.expectedDaemonId !== daemonId) throw new ProtocolError("fp_mismatch", "二维码指向的 daemon 与 relay 返回值不一致");
    const record = await deriveRecord(normalized.code, daemonId, pairRef);
    const prover = new Prover(record, idProver(pairRef), daemonId);
    const shareP = prover.start();
    send(socket.ws, jsonFrame(Typ.FWD, routeId, { v: 1, op: "SpakeShareP", share: b64url(shareP) }));
    const shareVMessage = await receivePairOp(socket, routeId, "SpakeShareV", 20_000);
    const shareV = parseExactB64(shareVMessage.share, 65, "shareV");
    const keys = prover.finish(shareV);
    if (!sameBytes(keys.confirmV, parseExactB64(shareVMessage.confirm_v, 32, "confirm_v"))) {
      throw new ProtocolError("bad_pair_code", "安全校验失败：配对码错误");
    }

    const pairKeys = pairingKeys(keys.kShared);
    const c2s = new Direction(pairKeys.c2s, DIR_C);
    const s2c = new Direction(pairKeys.s2c, DIR_S);
    // The frozen ConfirmPairing.sas field remains a machine-checked tag. It is
    // intentionally not exposed as an extra human comparison step.
    const localConfirmTag = sas(keys.kShared);
    send(socket.ws, jsonFrame(Typ.FWD, routeId, { v: 1, op: "SpakeConfirmP", confirm_p: b64url(keys.confirmP) }));
    options.onAwaitApproval?.();
    if (options.signal?.aborted) throw pairingCancelled();

    const onAbort = () => socket!.ws.close(1000, "pairing cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let confirmFrame: Frame | null = null;
    try {
      const deadline = Date.now() + 180_000;
      while (!confirmFrame && Date.now() < deadline) {
        if (options.signal?.aborted) throw pairingCancelled();
        let frame: Frame;
        try {
          frame = await socket.next(Math.max(1, deadline - Date.now()));
        } catch (error) {
          if (options.signal?.aborted) throw pairingCancelled();
          throw error;
        }
        if (frame.typ === Typ.PING) {
          requireHeartbeatPayload(frame.payload);
          send(socket.ws, { ...frame, typ: Typ.PONG });
        }
        else if (frame.typ === Typ.PONG) requireHeartbeatPayload(frame.payload);
        else if (frame.typ === Typ.ERROR) throw envelopeError(frame);
        else if (frame.typ === Typ.FWD) {
          if (!sameBytes(frame.routeId, routeId)) throw new ProtocolError("bad_frame", "ConfirmPairing route_id 不匹配");
          confirmFrame = frame;
        } else throw new ProtocolError("bad_frame", `等待确认时收到意外控制帧 ${frame.typ}`);
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    if (!confirmFrame) throw new ProtocolError("timeout", "等待电脑确认超时");
    let confirm: any;
    try {
      confirm = JSON.parse(decodeUTF8(s2c.open(routeId, confirmFrame.payload)));
    } catch {
      throw new ProtocolError("bad_message", "ConfirmPairing 解密失败");
    }
    if (confirm?.op !== "ConfirmPairing" || typeof confirm?.id !== "string" || !confirm.params) throw new ProtocolError("bad_message", "ConfirmPairing 格式错误");
    const params = confirm.params;
    if (!confirmationTagMatches(localConfirmTag, params.sas)) throw new ProtocolError("bad_message", "配对确认校验失败");
    if (params.daemon_id !== daemonId) throw new ProtocolError("bad_message", "daemon_id 在握手中发生变化");
    const daemonPk = parseExactB64(params.daemon_pk, 32, "daemon_pk");
    const psk = parseExactB64(params.device_psk, 32, "device_psk");
    const fp = fingerprint16(daemonPk);
    if (params.fp !== fp) throw new ProtocolError("fp_mismatch", "daemon 公钥指纹校验失败");
    if (options.expectedFingerprint && options.expectedFingerprint !== fp) throw new ProtocolError("fp_mismatch", "daemon 公钥与二维码指纹不一致");
    if (!validDeviceId(params.device_id)) throw new ProtocolError("bad_message", "ConfirmPairing device_id 非法");
    if (params.relay_origin && params.relay_origin !== origin) throw new ProtocolError("bad_relay", "daemon 返回的 relay origin 与当前站点不一致");
    const ack = c2s.seal(routeId, new TextEncoder().encode(JSON.stringify({ v: 1, id: confirm.id, ok: true, result: { label } })));
    send(socket.ws, { version: 1, typ: Typ.FWD, flags: 0, routeId, payload: ack });
    return {
      deviceId: params.device_id,
      psk,
      daemonPk,
      daemonId,
      fp,
      relayOrigin: origin,
      label,
      createdAt: Math.floor(Date.now() / 1000),
    };
  } catch (error) {
    if (options.signal?.aborted) throw pairingCancelled();
    if (!attachedReceived && protocol === 2 && pairingWsUsesTicket(relayWS)) {
      if (error instanceof ProtocolError && error.code === "unpaired") throw error;
      if (isPreAttachFailure(error)) {
        throw new ProtocolError("unpaired", "配对码过期或已用过，请抄电脑 pairfob 打印的当前码");
      }
    }
    throw error;
  } finally {
    if (pairHeartbeat !== null) clearInterval(pairHeartbeat);
    socket?.ws.close(1000, "pairing complete");
  }
}
