import { decode, encode, ENVELOPE_VERSION, HEADER_SIZE, MAX_PAYLOAD, Typ, type Frame } from "./envelope.ts";
import { ZERO_ROUTE } from "./crypto.ts";

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export function jsonBytes(obj: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(obj));
}

export function parseJSONObject(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const v = JSON.parse(utf8d.decode(payload)) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function encodeJSON(typ: number, routeId: Uint8Array, obj: unknown): Uint8Array {
  return encode({
    version: ENVELOPE_VERSION,
    typ,
    flags: 0,
    routeId,
    payload: jsonBytes(obj),
  });
}

export function encodeRaw(typ: number, routeId: Uint8Array, payload: Uint8Array): Uint8Array {
  return encode({ version: ENVELOPE_VERSION, typ, flags: 0, routeId, payload });
}

export interface WireSink {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface DecodedMessage {
  frame: Frame;
  wire: Uint8Array;
}

export function sendFrame(ws: WireSink, frame: Frame): void {
  ws.send(encode(frame));
}

export function sendJSON(ws: WireSink, typ: number, routeId: Uint8Array, obj: unknown): void {
  ws.send(encodeJSON(typ, routeId, obj));
}

export function sendErr(
  ws: WireSink,
  code: string,
  message: string,
  extra?: { routeId?: Uint8Array; pairRef?: string },
): void {
  const routeId = extra?.routeId ?? ZERO_ROUTE;
  const body: Record<string, unknown> = { v: 2, code, message };
  if (extra?.routeId && extra.routeId.length === 16) body.route_id = [...extra.routeId].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (extra?.pairRef) body.pair_ref = extra.pairRef;
  sendJSON(ws, Typ.ERROR, routeId, body);
}

export function reject(ws: WireSink, code: string, message: string): void {
  sendErr(ws, code, message);
  ws.close(1000, code);
}

export function asBytes(message: string | ArrayBuffer | Uint8Array): Uint8Array | null {
  if (typeof message === "string") return null;
  if (message instanceof Uint8Array) return message;
  return new Uint8Array(message);
}

/** `undefined` is not FWD, `null` is malformed FWD, and bytes are a validated FWD envelope. */
export function decodeFwdMessage(message: string | ArrayBuffer | Uint8Array): Uint8Array | null | undefined {
  const wire = asBytes(message);
  if (!wire || wire.length < 2 || wire[1] !== Typ.FWD) return undefined;
  if (wire.length < HEADER_SIZE || wire[0] !== ENVELOPE_VERSION || wire[2] !== 0 || wire[3] !== 0) return null;
  const payloadLength = wire[4] * 0x1000000 + (wire[5] << 16) + (wire[6] << 8) + wire[7];
  if (payloadLength > MAX_PAYLOAD || wire.length !== HEADER_SIZE + payloadLength) return null;
  return wire;
}

export function decodeMessage(message: string | ArrayBuffer | Uint8Array): DecodedMessage | null {
  const wire = asBytes(message);
  if (!wire) return null;
  try {
    return { frame: decode(wire), wire };
  } catch {
    return null;
  }
}
