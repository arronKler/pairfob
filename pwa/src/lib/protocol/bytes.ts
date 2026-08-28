export function encStr(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const out = new Uint8Array(8 + b.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(b.length), true);
  out.set(b, 8);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function u64be(n: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

export function lenPref(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + b.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(b.length), true);
  out.set(b, 8);
  return out;
}

export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64url(b: Uint8Array): string {
  let acc = 0,
    bits = 0,
    out = "";
  for (const c of b) {
    acc = (acc << 8) | c;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64[(acc >> bits) & 63];
    }
  }
  if (bits) out += B64[(acc << (6 - bits)) & 63];
  return out;
}

export function b64urlDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error("b64url length");
  const rev = new Map([...B64].map((c, i) => [c, i]));
  let acc = 0,
    bits = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = rev.get(ch);
    if (v === undefined) throw new Error("b64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error("b64url tail bits");
  const decoded = new Uint8Array(out);
  if (b64url(decoded) !== s) throw new Error("b64url non-canonical");
  return decoded;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("base64");
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  if (base64Encode(out) !== value) throw new Error("base64 non-canonical");
  return out;
}

export function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

export function normalizeCrockford(s: string): string {
  return s
    .toUpperCase()
    .replace(/[ \-/_]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
}
