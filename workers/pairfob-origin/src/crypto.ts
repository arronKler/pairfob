const enc = new TextEncoder();
const HEX_BYTE = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX_BYTE[bytes[i]];
  return out;
}

export function routeHexAt(bytes: Uint8Array, offset: number): string {
  if (!Number.isInteger(offset) || offset < 0 || offset + 16 > bytes.length) {
    throw new Error("route_id must be 16 bytes");
  }
  let out = "";
  const end = offset + 16;
  for (let i = offset; i < end; i++) out += HEX_BYTE[bytes[i]];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(n)) throw new Error("bad hex");
    out[i] = n;
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomHex(byteLen: number): string {
  return bytesToHex(randomBytes(byteLen));
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return bytesToHex(new Uint8Array(buf));
}

export async function hmacSha256Hex(pepper: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(mac));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const n = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < n; i++) {
    const x = i < ba.length ? ba[i] : 0;
    const y = i < bb.length ? bb[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

export function isLowerHex(s: string, byteLen: number): boolean {
  if (s.length !== byteLen * 2) return false;
  try {
    return bytesToHex(hexToBytes(s)) === s;
  } catch {
    return false;
  }
}

export const ZERO_ROUTE = new Uint8Array(16);

export function isZeroRoute(rid: Uint8Array): boolean {
  if (rid.length !== 16) return false;
  for (let i = 0; i < 16; i++) if (rid[i] !== 0) return false;
  return true;
}

export function routeHex(rid: Uint8Array): string {
  return bytesToHex(rid);
}

export function routeFromHex(hex: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== 16) throw new Error("route_id must be 16 bytes");
  return b;
}

export function newRouteId(random: (n: number) => Uint8Array = randomBytes): Uint8Array {
  for (let i = 0; i < 8; i++) {
    const b = random(16);
    if (!isZeroRoute(b)) return b;
  }
  throw new Error("relay entropy unavailable");
}
