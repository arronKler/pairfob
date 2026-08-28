import { describe, expect, test } from "bun:test";
import { decode, decodeUTF8, encode, MAX_PAYLOAD, Typ, type Frame } from "./envelope.ts";

const route = new Uint8Array(16);
const valid = (): Frame => ({ version: 1, typ: Typ.PING, flags: 0, routeId: route, payload: new Uint8Array(8) });

describe("envelope input boundaries", () => {
  test("round trips a strict valid frame", () => {
    expect(decode(encode(valid()))).toEqual(valid());
  });

  test("encode rejects invalid version, flags, type, route and payload cap", () => {
    expect(() => encode({ ...valid(), version: 0 })).toThrow("version");
    expect(() => encode({ ...valid(), flags: 1 })).toThrow("flags");
    expect(() => encode({ ...valid(), typ: 0xff })).toThrow("unknown");
    expect(() => encode({ ...valid(), routeId: new Uint8Array(15) })).toThrow("route_id");
    expect(() => encode({ ...valid(), payload: new Uint8Array(MAX_PAYLOAD + 1) })).toThrow("exceeds");
  });

  test("decode rejects the same wire invariants and oversized declared length", () => {
    const badVersion = encode(valid());
    badVersion[0] = 2;
    expect(() => decode(badVersion)).toThrow("version");
    const badFlags = encode(valid());
    badFlags[3] = 1;
    expect(() => decode(badFlags)).toThrow("flags");
    const badType = encode(valid());
    badType[1] = 0xff;
    expect(() => decode(badType)).toThrow("unknown");
    const declared = new Uint8Array(24);
    declared[0] = 1;
    declared[1] = Typ.FWD;
    new DataView(declared.buffer).setUint32(4, MAX_PAYLOAD + 1, false);
    expect(() => decode(declared)).toThrow("exceeds");
  });

  test("network UTF-8 decoding is fatal", () => {
    expect(() => decodeUTF8(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(decodeUTF8(new TextEncoder().encode("犬舍"))).toBe("犬舍");
  });
});
