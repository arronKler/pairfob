import { describe, expect, test } from "bun:test";
import { decode, ENVELOPE_VERSION, HEADER_SIZE, MAX_PAYLOAD, Typ } from "./envelope.ts";
import { decodeFwdMessage, encodeRaw } from "./frames.ts";
import { ZERO_ROUTE } from "./crypto.ts";

describe("FWD envelope fast decoder", () => {
  test("returns the original validated wire without constructing a frame", () => {
    const wire = encodeRaw(Typ.FWD, ZERO_ROUTE, new Uint8Array([1, 2, 3]));

    expect(decodeFwdMessage(wire)).toBe(wire);
    const fromBuffer = decodeFwdMessage(wire.buffer);
    expect(fromBuffer).toBeInstanceOf(Uint8Array);
    expect(fromBuffer?.buffer).toBe(wire.buffer);

    const nested = new Uint8Array(wire.length + 7);
    nested.set(wire, 7);
    const view = nested.subarray(7);
    expect(decodeFwdMessage(view)).toBe(view);
  });

  test("leaves non-FWD messages to the general decoder", () => {
    expect(decodeFwdMessage(encodeRaw(Typ.PING, ZERO_ROUTE, new Uint8Array(8)))).toBeUndefined();
    expect(decodeFwdMessage("not binary")).toBeUndefined();
    expect(decodeFwdMessage(new Uint8Array([ENVELOPE_VERSION]))).toBeUndefined();
  });

  test("rejects malformed FWD candidates fail-closed", () => {
    const malformed: Uint8Array[] = [];
    malformed.push(new Uint8Array([ENVELOPE_VERSION, Typ.FWD]));

    const wrongVersion = encodeRaw(Typ.FWD, ZERO_ROUTE, new Uint8Array());
    wrongVersion[0]++;
    malformed.push(wrongVersion);

    const nonzeroFlags = encodeRaw(Typ.FWD, ZERO_ROUTE, new Uint8Array());
    nonzeroFlags[3] = 1;
    malformed.push(nonzeroFlags);

    const lengthMismatch = encodeRaw(Typ.FWD, ZERO_ROUTE, new Uint8Array([1]));
    lengthMismatch[7] = 2;
    malformed.push(lengthMismatch);

    const oversized = new Uint8Array(HEADER_SIZE);
    oversized[0] = ENVELOPE_VERSION;
    oversized[1] = Typ.FWD;
    new DataView(oversized.buffer).setUint32(4, MAX_PAYLOAD + 1, false);
    malformed.push(oversized);

    for (const wire of malformed) expect(decodeFwdMessage(wire)).toBeNull();
  });

  test("accepts exactly the same FWD byte boundaries as the general decoder", () => {
    const candidates: Uint8Array[] = [];
    const valid = encodeRaw(Typ.FWD, ZERO_ROUTE, Uint8Array.from({ length: 64 }, (_, value) => value));

    for (let length = 2; length < HEADER_SIZE; length++) {
      const short = new Uint8Array(length);
      short[0] = ENVELOPE_VERSION;
      short[1] = Typ.FWD;
      candidates.push(short);
    }
    for (let index = 0; index < HEADER_SIZE; index++) {
      for (const value of [0, 1, Typ.FWD, 0xff]) {
        const mutated = valid.slice();
        mutated[index] = value;
        if (mutated[1] === Typ.FWD) candidates.push(mutated);
      }
    }
    for (const declared of [0, 1, 63, 64, 65, MAX_PAYLOAD, MAX_PAYLOAD + 1, 0xffffffff]) {
      const mutated = valid.slice();
      new DataView(mutated.buffer).setUint32(4, declared, false);
      candidates.push(mutated);
    }

    for (const wire of candidates) {
      let acceptedByGeneralDecoder = false;
      try {
        acceptedByGeneralDecoder = decode(wire).typ === Typ.FWD;
      } catch {
        // Both decoders reject malformed external input without exposing parser details.
      }
      expect(decodeFwdMessage(wire) instanceof Uint8Array).toBe(acceptedByGeneralDecoder);
    }
  });
});
