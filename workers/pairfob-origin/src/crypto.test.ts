import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes, routeHexAt } from "./crypto.ts";

describe("hex encoding", () => {
  test("encodes every byte as the same lowercase two-digit representation", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, value) => value);
    const expected = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

    expect(bytesToHex(bytes)).toBe(expected);
    expect(hexToBytes(expected)).toEqual(bytes);
  });

  test("encodes a route directly from an envelope-sized byte range", () => {
    const wire = Uint8Array.from({ length: 40 }, (_, value) => value);

    expect(routeHexAt(wire, 8)).toBe(bytesToHex(wire.subarray(8, 24)));
    expect(() => routeHexAt(wire, -1)).toThrow("route_id must be 16 bytes");
    expect(() => routeHexAt(wire, 25)).toThrow("route_id must be 16 bytes");
    expect(() => routeHexAt(wire, 1.5)).toThrow("route_id must be 16 bytes");
  });
});
