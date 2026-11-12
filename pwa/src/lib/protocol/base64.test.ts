import { describe, expect, test } from "bun:test";
import { base64Decode, base64Encode } from "./base64";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function exerciseCodec(): void {
  for (const size of [0, 1, 2, 3, 255, 256, 257, 24 * 1024, 96 * 1024, 96 * 1024 - 1, 4 * 1024 * 1024]) {
    const backing = Uint8Array.from({ length: size + 2 }, (_, index) => index & 255);
    const bytes = backing.subarray(1, size + 1);
    const encoded = Buffer.from(bytes).toString("base64");
    expect(base64Encode(bytes)).toBe(encoded);
    expect(base64Decode(encoded)).toEqual(bytes);
  }
  for (const invalid of ["A", "AA", "AAA", "====", "A===", "=AAA", "AA=A", "AA==AAAA", "AA-_", "AAA\n", "AA\r\n", "AA==\n", "AA==\r\n  ", "AA\t=", "AA =", "AA\0=", "ＡAAA"]) {
    expect(() => base64Decode(invalid), JSON.stringify(invalid)).toThrow("base64");
  }
  // Every possible discarded-bit combination, for both padded lengths.
  for (let tail = 0; tail < 64; tail++) {
    for (const padding of [1, 2]) {
      const value = `${padding === 2 ? "A" : "AA"}${alphabet[tail]}${"=".repeat(padding)}`;
      if (tail & (padding === 2 ? 15 : 3)) expect(() => base64Decode(value)).toThrow("non-canonical");
      else expect(base64Encode(base64Decode(value))).toBe(value);
    }
  }
}

describe("canonical standard Base64", () => {
  test("native codecs preserve all bytes and reject noncanonical inputs", exerciseCodec);

  test("older browsers retain the same validation and results", () => {
    const decoder = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    const encoder = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
    try {
      Object.defineProperty(Uint8Array, "fromBase64", { value: undefined, configurable: true });
      Object.defineProperty(Uint8Array.prototype, "toBase64", { value: undefined, configurable: true });
      exerciseCodec();
    } finally {
      if (decoder) Object.defineProperty(Uint8Array, "fromBase64", decoder);
      else Reflect.deleteProperty(Uint8Array, "fromBase64");
      if (encoder) Object.defineProperty(Uint8Array.prototype, "toBase64", encoder);
      else Reflect.deleteProperty(Uint8Array.prototype, "toBase64");
    }
  });
});
