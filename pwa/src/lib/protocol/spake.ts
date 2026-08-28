import { p256 } from "@noble/curves/p256.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { argon2id } from "hash-wasm";
import { concat, encStr, hexToBytes, lenPref } from "./bytes.ts";
import { hmacSha256, pairfobHKDF } from "./kdf.ts";

export const CONTEXT = "pairfob-v1/spake2plus";

const M = hexToBytes(
  "04886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f5ff355163e43ce224e0b0e65ff02ac8e5c7be09419c785e0ca547d55a12e2d20",
);
const N = hexToBytes(
  "04d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b4907d60aa6bfade45008a636337f5168c64d9bd36034808cd564490b1e656edbe7",
);

const ORDER = p256.CURVE.n;

function os2ipMod(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n % ORDER;
}

function pad32(n: bigint): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const raw = hexToBytes(hex);
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
}

function pointMul(p: Uint8Array, k: bigint) {
  return p256.ProjectivePoint.fromHex(p).multiply(k);
}

function pointAdd(a: ReturnType<typeof pointMul>, b: ReturnType<typeof pointMul>) {
  return a.add(b);
}

function uncomp(p: ReturnType<typeof pointMul>): Uint8Array {
  return p.toRawBytes(false);
}

export interface Record {
  w0: bigint;
  w1: bigint;
  L: Uint8Array;
}

export async function deriveRecord(normalizedS: string, daemonId: string, pairRefHex: string): Promise<Record> {
  const saltFull = sha256(
    concat(encStr("pairfob-v1/pake-salt"), encStr(daemonId), encStr(pairRefHex)),
  );
  const salt = new Uint8Array(saltFull.subarray(0, 16));
  const expanded = await argon2id({
    password: normalizedS,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 80,
    outputType: "binary",
  });
  const w0 = os2ipMod(expanded.slice(0, 40));
  const w1 = os2ipMod(expanded.slice(40, 80));
  const L = uncomp(p256.ProjectivePoint.BASE.multiply(w1));
  return { w0, w1, L };
}

export interface SpakeKeys {
  kShared: Uint8Array;
  confirmP: Uint8Array;
  confirmV: Uint8Array;
}

export function computeKeys(
  ctx: string,
  idP: string,
  idV: string,
  shareP: Uint8Array,
  shareV: Uint8Array,
  Z: Uint8Array,
  V: Uint8Array,
  w0: bigint,
): SpakeKeys {
  const tt = concat(
    encStr(ctx),
    encStr(idP),
    encStr(idV),
    lenPref(M),
    lenPref(N),
    lenPref(shareP),
    lenPref(shareV),
    lenPref(Z),
    lenPref(V),
    lenPref(pad32(w0)),
  );
  const kMain = sha256(tt);
  const conf = pairfobHKDF(kMain, null, new TextEncoder().encode("ConfirmationKeys"), 64);
  return {
    kShared: pairfobHKDF(kMain, null, new TextEncoder().encode("SharedKey"), 32),
    confirmP: hmacSha256(conf.slice(0, 32), shareV),
    confirmV: hmacSha256(conf.slice(32), shareP),
  };
}

export class Prover {
  x = 0n;
  shareP = new Uint8Array();
  constructor(
    public rec: Record,
    public idP: string,
    public idV: string,
    public ctx = CONTEXT,
  ) {}

  start(x?: bigint): Uint8Array {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    this.x = x ?? os2ipMod(bytes);
    if (this.x === 0n) this.x = 1n;
    const wM = pointMul(M, this.rec.w0);
    const xP = p256.ProjectivePoint.BASE.multiply(this.x);
    this.shareP = new Uint8Array(uncomp(pointAdd(xP, wM)));
    return this.shareP;
  }

  finish(shareV: Uint8Array): SpakeKeys {
    const Y = p256.ProjectivePoint.fromHex(shareV);
    const wN = pointMul(N, this.rec.w0);
    const tmp = Y.add(wN.negate());
    const Z = uncomp(tmp.multiply(this.x));
    const V = uncomp(tmp.multiply(this.rec.w1));
    return computeKeys(this.ctx, this.idP, this.idV, this.shareP, shareV, Z, V, this.rec.w0);
  }
}

export function idProver(pairRefHex: string): string {
  return "phone" + pairRefHex;
}
