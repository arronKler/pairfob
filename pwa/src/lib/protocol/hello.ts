import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import words from "../../../../proto/pgp-words.json";
import { b64url, concat, encStr, u64be } from "./bytes.ts";
import { hmacSha256, pairfobHKDF, zeros32 } from "./kdf.ts";

export function sas(kShared: Uint8Array): string {
  const key = pairfobHKDF(kShared, zeros32, new TextEncoder().encode("pairfob-v1/sas"), 4);
  return words.even[key[0]] + "-" + words.odd[key[1]];
}

export function fingerprint16(rawPk: Uint8Array): string {
  return b64url(sha256(rawPk).slice(0, 16));
}

export function transcriptD(
  daemonId: string,
  deviceId: string,
  ephP: Uint8Array,
  ephD: Uint8Array,
  nonce: Uint8Array,
  ts: bigint,
  routeId: Uint8Array,
): Uint8Array {
  return concat(
    encStr("pairfob-v1/hello-d"),
    encStr(daemonId),
    encStr(deviceId),
    ephP,
    ephD,
    nonce,
    u64be(ts),
    routeId,
  );
}

export function transcriptP(td: Uint8Array): Uint8Array {
  return concat(encStr("pairfob-v1/hello-p"), td);
}

export function proof(psk: Uint8Array, transcript: Uint8Array): Uint8Array {
  return hmacSha256(psk, transcript);
}

export function verifyEd25519(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  return ed25519.verify(sig, msg, pk);
}
