import { normalizeCrockford } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import type { MuxProtocol } from "./mux.ts";

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
  /** This browser's local name for the computer; never crosses the protocol. */
  alias?: string;
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
