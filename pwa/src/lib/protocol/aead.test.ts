import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aad, Direction, DIR_C, MAX_PAYLOAD, MAX_PLAINTEXT } from "./aead.ts";
import { bytesToHex, hexToBytes } from "./bytes.ts";

const vec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../proto/pairfob-vectors.json"), "utf8"),
);

describe("FWD AEAD", () => {
  test("seal matches frozen aead_ping", () => {
    expect(MAX_PLAINTEXT).toBe(vec.max_plain);
    const key = hexToBytes(vec.pair_c2s);
    const rid = hexToBytes(vec.pair_ref_hex);
    const a = new Direction(key, DIR_C);
    const payload = a.seal(rid, new TextEncoder().encode(vec.ping_pt));
    expect(bytesToHex(payload)).toBe(vec.aead_ping);
    const b = new Direction(key, DIR_C);
    const got = b.open(rid, payload);
    expect(new TextDecoder().decode(got)).toBe(vec.ping_pt);
  });

  test("rejects cap before consuming sequence", () => {
    const key = new Uint8Array(32);
    const route = new Uint8Array(16);
    const direction = new Direction(key, DIR_C);
    expect(() => direction.seal(route, new Uint8Array(MAX_PLAINTEXT + 1))).toThrow("plaintext exceeds");
    expect(direction.seq).toBe(0n);
    expect(() => direction.open(route, new Uint8Array(27))).toThrow("payload length");
    expect(() => direction.open(route, new Uint8Array(MAX_PAYLOAD + 1))).toThrow("payload length");
  });

  test("rejects nonce prefix, replay, route and direction", () => {
    const key = new Uint8Array(32);
    const route = new Uint8Array(16);
    const sealed = new Direction(key, DIR_C).seal(route, new Uint8Array([1, 2, 3]));
    const badNonce = sealed.slice();
    badNonce[0] = 1;
    expect(() => new Direction(key, DIR_C).open(route, badNonce)).toThrow("seq mismatch");
    const opener = new Direction(key, DIR_C);
    expect([...opener.open(route, sealed)]).toEqual([1, 2, 3]);
    expect(() => opener.open(route, sealed)).toThrow("seq mismatch");
    expect(() => new Direction(key, DIR_C).open(new Uint8Array(16).fill(1), sealed)).toThrow();
    expect(() => aad(new Uint8Array(15), DIR_C)).toThrow("route_id");
    expect(() => aad(route, 0)).toThrow("direction");
  });
});
