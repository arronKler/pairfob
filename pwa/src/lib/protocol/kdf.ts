import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { zeros } from "./bytes.ts";

export const zeros32 = zeros(32);

export function pairfobHKDF(ikm: Uint8Array, salt: Uint8Array | null, info: Uint8Array, L: number): Uint8Array {
  return hkdf(sha256, ikm, salt ?? zeros32, info, L);
}

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  return hmac(sha256, key, msg);
}

export function pairingKeys(kShared: Uint8Array): { c2s: Uint8Array; s2c: Uint8Array } {
  const te = new TextEncoder();
  const root = pairfobHKDF(kShared, zeros32, te.encode("pairfob-v1/pair-root"), 32);
  return {
    c2s: pairfobHKDF(root, zeros32, te.encode("pairfob-v1/pair-c2s"), 32),
    s2c: pairfobHKDF(root, zeros32, te.encode("pairfob-v1/pair-s2c"), 32),
  };
}

export function sessionKeys(dh: Uint8Array, devicePsk: Uint8Array): { c2s: Uint8Array; s2c: Uint8Array } {
  const ikm = new Uint8Array(64);
  ikm.set(dh, 0);
  ikm.set(devicePsk, 32);
  const te = new TextEncoder();
  const root = pairfobHKDF(ikm, zeros32, te.encode("pairfob-v1/sess-root"), 32);
  return {
    c2s: pairfobHKDF(root, zeros32, te.encode("pairfob-v1/sess-c2s"), 32),
    s2c: pairfobHKDF(root, zeros32, te.encode("pairfob-v1/sess-s2c"), 32),
  };
}
