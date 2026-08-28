import { describe, expect, test } from "bun:test";
import { decode, encode, ENVELOPE_VERSION, HEADER_SIZE, MAX_PAYLOAD, Typ, type Frame } from "./envelope.ts";

const routeId = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

function frame(over: Partial<Frame> = {}): Frame {
  return {
    version: ENVELOPE_VERSION,
    typ: Typ.PING,
    flags: 0,
    routeId,
    payload: new Uint8Array([0xaa, 0xbb, 0xcc]),
    ...over,
  };
}

describe("envelope codec", () => {
  test("roundtrips the 24-byte header and opaque payload", () => {
    const src = frame({ typ: Typ.FWD, payload: new Uint8Array([9, 8, 7, 6, 5]) });
    const wire = encode(src);
    expect(wire.byteLength).toBe(HEADER_SIZE + src.payload.length);
    expect(wire[0]).toBe(0x01);
    expect(wire[1]).toBe(Typ.FWD);
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    expect(view.getUint16(2, false)).toBe(0);
    expect(view.getUint32(4, false)).toBe(src.payload.length);
    expect(wire.slice(8, 24)).toEqual(routeId);
    expect(wire.slice(HEADER_SIZE)).toEqual(src.payload);
    const decoded = decode(wire);
    expect(decoded).toEqual(src);
    expect(decoded.routeId.buffer).toBe(wire.buffer);
    expect(decoded.payload.buffer).toBe(wire.buffer);

    const offset = 7;
    const nested = new Uint8Array(offset + wire.length);
    nested.set(wire, offset);
    expect(decode(nested.subarray(offset))).toEqual(src);
  });

  test("decode rejects length > 262144 before requiring a full body", () => {
    const declared = new Uint8Array(HEADER_SIZE);
    declared[0] = ENVELOPE_VERSION;
    declared[1] = Typ.FWD;
    new DataView(declared.buffer).setUint32(4, MAX_PAYLOAD + 1, false);
    expect(() => decode(declared)).toThrow(`length > ${MAX_PAYLOAD}`);
  });

  test("encode rejects payload longer than 262144", () => {
    expect(() => encode(frame({ payload: new Uint8Array(MAX_PAYLOAD + 1) }))).toThrow("exceeds");
  });

  test("rejects nonzero flags on encode and decode", () => {
    expect(() => encode(frame({ flags: 1 }))).toThrow("flags");
    const wire = encode(frame());
    new DataView(wire.buffer, wire.byteOffset, wire.byteLength).setUint16(2, 1, false);
    expect(() => decode(wire)).toThrow("flags");
  });

  test("accepts every Go typ 0x01–0x0F except unused 0x0a", () => {
    const types = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f];
    expect(Object.values(Typ).sort((a, b) => a - b)).toEqual(types);
    for (const typ of types) {
      const src = frame({ typ });
      expect(decode(encode(src))).toEqual(src);
    }
    expect(() => encode(frame({ typ: 0x0a }))).toThrow("unknown");
  });
});
