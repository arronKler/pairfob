import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

export const MAX_PLAINTEXT = 262116;
export const MAX_PAYLOAD = 262144;
export const DIR_C = 0x63; // 'c'
export const DIR_S = 0x73; // 's'

export function aad(routeId: Uint8Array, dir: number): Uint8Array {
  if (!(routeId instanceof Uint8Array) || routeId.length !== 16) throw new Error("route_id must be 16 bytes");
  if (dir !== DIR_C && dir !== DIR_S) throw new Error("invalid AEAD direction");
  const out = new Uint8Array(21);
  out[0] = 0x01;
  out[1] = 0x05;
  out.set(routeId, 4);
  out[20] = dir;
  return out;
}

export class Direction {
  seq = 0n;
  constructor(
    public key: Uint8Array,
    public dir: number,
  ) {}

  seal(routeId: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!(plaintext instanceof Uint8Array)) throw new Error("plaintext must be bytes");
    if (plaintext.length > MAX_PLAINTEXT) throw new Error("plaintext exceeds 262116");
    if (this.seq < 0n || this.seq > 0xffff_ffff_ffff_ffffn) throw new Error("aead seq overflow");
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, this.seq, false);
    const cipher = chacha20poly1305(this.key, nonce, aad(routeId, this.dir));
    const ct = cipher.encrypt(plaintext);
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0);
    out.set(ct, 12);
    this.seq++;
    return out;
  }

  open(routeId: Uint8Array, payload: Uint8Array): Uint8Array {
    if (!(payload instanceof Uint8Array) || payload.length < 28 || payload.length > MAX_PAYLOAD) {
      throw new Error("aead payload length");
    }
    const nonce = payload.slice(0, 12);
    const rest = payload.slice(12);
    if (nonce[0] !== 0 || nonce[1] !== 0 || nonce[2] !== 0 || nonce[3] !== 0) throw new Error("aead seq mismatch");
    const got = new DataView(nonce.buffer, nonce.byteOffset, 12).getBigUint64(4, false);
    if (got !== this.seq) throw new Error("aead seq mismatch");
    const cipher = chacha20poly1305(this.key, nonce, aad(routeId, this.dir));
    const pt = cipher.decrypt(rest);
    this.seq++;
    return pt;
  }
}
