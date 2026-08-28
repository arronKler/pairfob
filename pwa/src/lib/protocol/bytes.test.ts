import { describe, expect, test } from "bun:test";
import { b64url, b64urlDecode } from "./bytes.ts";

describe("canonical base64url", () => {
  test("round trips canonical unpadded values", () => {
    for (const bytes of [new Uint8Array(), new Uint8Array([0]), new Uint8Array([0, 1]), new Uint8Array([0, 1, 2])]) {
      expect(b64urlDecode(b64url(bytes))).toEqual(bytes);
    }
  });

  test("rejects impossible length, nonzero tail bits, padding and alphabet", () => {
    expect(() => b64urlDecode("A")).toThrow("length");
    expect(() => b64urlDecode("AB")).toThrow("tail bits");
    expect(() => b64urlDecode("AAB")).toThrow("tail bits");
    expect(() => b64urlDecode("AA==")).toThrow();
    expect(() => b64urlDecode("AA+")).toThrow();
  });
});
