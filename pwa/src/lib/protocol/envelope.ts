export const Typ = {
  HELLO_DAEMON: 0x01,
  HELLO_CLIENT: 0x02,
  PAIR_OPEN: 0x03,
  PAIR_ATTACH: 0x04,
  FWD: 0x05,
  PAIR_CLOSE: 0x06,
  ERROR: 0x07,
  PING: 0x08,
  PONG: 0x09,
  PAIR_ATTACHED: 0x0b,
  SESSION_ATTACH: 0x0c,
  SESSION_BOUND: 0x0d,
  DAEMON_REPLACED: 0x0e,
  SESSION_ESTABLISHED: 0x0f,
} as const;

export const ENVELOPE_VERSION = 1;
export const HEADER_SIZE = 24;
export const MAX_PAYLOAD = 262_144;
const KNOWN_TYPES = new Set<number>(Object.values(Typ));
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

export interface Frame {
  version: number;
  typ: number;
  flags: number;
  routeId: Uint8Array;
  payload: Uint8Array;
}

export function validateFrame(frame: Frame): void {
  if (frame.version !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${frame.version}`);
  if (frame.flags !== 0) throw new Error(`unsupported envelope flags 0x${frame.flags.toString(16)}`);
  if (!KNOWN_TYPES.has(frame.typ)) throw new Error(`unknown envelope type 0x${frame.typ.toString(16)}`);
  if (!(frame.routeId instanceof Uint8Array) || frame.routeId.length !== 16) throw new Error("route_id must be 16 bytes");
  if (!(frame.payload instanceof Uint8Array)) throw new Error("payload must be bytes");
  if (frame.payload.length > MAX_PAYLOAD) throw new Error(`payload length ${frame.payload.length} exceeds ${MAX_PAYLOAD}`);
}

export function encode(frame: Frame): Uint8Array {
  validateFrame(frame);
  const out = new Uint8Array(HEADER_SIZE + frame.payload.length);
  out[0] = frame.version;
  out[1] = frame.typ;
  const view = new DataView(out.buffer);
  view.setUint16(2, frame.flags, false);
  view.setUint32(4, frame.payload.length, false);
  out.set(frame.routeId, 8);
  out.set(frame.payload, HEADER_SIZE);
  return out;
}

export function decode(bytes: Uint8Array): Frame {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_SIZE) throw new Error("short frame");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, false);
  if (length > MAX_PAYLOAD) throw new Error(`payload length ${length} exceeds ${MAX_PAYLOAD}`);
  if (length + HEADER_SIZE !== bytes.length) throw new Error("length mismatch");
  const frame: Frame = {
    version: bytes[0],
    typ: bytes[1],
    flags: view.getUint16(2, false),
    routeId: bytes.slice(8, 24),
    payload: bytes.slice(HEADER_SIZE),
  };
  validateFrame(frame);
  return frame;
}

export function jsonFrame(typ: number, routeId: Uint8Array, obj: unknown): Frame {
  const frame = { version: ENVELOPE_VERSION, typ, flags: 0, routeId, payload: new TextEncoder().encode(JSON.stringify(obj)) };
  validateFrame(frame);
  return frame;
}

export function decodeUTF8(bytes: Uint8Array): string {
  return UTF8_FATAL.decode(bytes);
}

export function parseJSON(frame: Frame): any {
  return JSON.parse(decodeUTF8(frame.payload));
}
