import { b64url, b64urlDecode, normalizeCrockford } from "./protocol/bytes.ts";
import { validDaemonId } from "./identifiers.ts";
import type { MuxProtocol } from "./protocol/mux.ts";

export interface FragmentPairing {
  v: 1 | 2;
  pairRef: string;
  code: string;
  daemonId?: string;
  fingerprint?: string;
  loc?: string;
}

// HTML pattern is compiled with the RegExp v flag. Its character classes
// require literal hyphen and slash to be escaped explicitly.
export const PAIR_CODE_PATTERN = "[0-9A-Za-z]{4}[\\- \\/_]?[0-9A-Za-z]{4}";
export const PAIR_CODE_WITH_LOCATOR_PATTERN =
  "[0-9A-Za-z]{4}[\\- \\/_]?[0-9A-Za-z]{4}[\\- \\/_]*[0-9A-Za-z]{6}";

export function parsePairingCode(raw: string): string | null {
  const code = normalizeCrockford(raw);
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : null;
}

export function parsePairLocator(raw: string): string | null {
  const loc = normalizeCrockford(raw);
  return /^[0-9A-HJKMNP-TV-Z]{6}$/.test(loc) ? loc : null;
}

/** Accept `CODE LOC` or a 14-glyph Crockford blob. `s` stays 8 chars; loc is independent. */
export function parseCodeAndLocator(raw: string): { code: string; loc: string } | null {
  const normalized = normalizeCrockford(raw);
  if (normalized.length !== 14) return null;
  const code = parsePairingCode(normalized.slice(0, 8));
  const loc = parsePairLocator(normalized.slice(8));
  if (!code || !loc) return null;
  return { code, loc };
}

export type HandPairing =
  | { ok: true; code: string; loc?: string }
  | { ok: false; field: "code"; error: "invalid_pair_code" | "locator_required" };

/** Local hand-entry gate. Hosted manual entry is one 14-glyph user-facing code. */
export function resolveHandPairing(protocol: MuxProtocol, rawInput: string, fromQR: boolean): HandPairing {
  if (protocol === 2 && !fromQR) {
    const combined = parseCodeAndLocator(rawInput);
    if (combined) return { ok: true, ...combined };
    const normalized = normalizeCrockford(rawInput);
    if (normalized.length >= 8 && normalized.length < 14 && parsePairingCode(normalized.slice(0, 8))) {
      return { ok: false, field: "code", error: "locator_required" };
    }
    return { ok: false, field: "code", error: "invalid_pair_code" };
  }
  const code = parsePairingCode(rawInput);
  return code ? { ok: true, code } : { ok: false, field: "code", error: "invalid_pair_code" };
}

export function fragmentUsableOnOrigin(fragment: FragmentPairing, protocol: MuxProtocol): boolean {
  return fragment.v === protocol;
}

function parseFingerprint(value: string): string | null {
  try {
    const bytes = b64urlDecode(value);
    if (bytes.length !== 16 || b64url(bytes) !== value) return null;
    return value;
  } catch {
    return null;
  }
}

/** Parse QR-only pairing material from the fragment. The caller must strip it immediately. */
export function parsePairingFragment(hash: string): FragmentPairing | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const version = params.get("v");
  if (version !== "1" && version !== "2") return null;
  const pairRef = (params.get("r") || "").toLowerCase();
  const code = normalizeCrockford(params.get("c") || "");
  const daemonId = params.get("d") || undefined;
  const fingerprintRaw = params.get("fp") || undefined;
  if (!/^[0-9a-f]{32}$/.test(pairRef) || !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) return null;
  if (daemonId && !validDaemonId(daemonId)) return null;
  if (version === "1") {
    let fingerprint: string | undefined;
    if (fingerprintRaw) {
      const parsed = parseFingerprint(fingerprintRaw);
      if (!parsed) return null;
      fingerprint = parsed;
    }
    return { v: 1, pairRef, code, daemonId, fingerprint };
  }
  if (!daemonId || !fingerprintRaw) return null;
  const fingerprint = parseFingerprint(fingerprintRaw);
  if (!fingerprint) return null;
  const locRaw = params.get("loc");
  let loc: string | undefined;
  if (locRaw) {
    const parsed = parsePairLocator(locRaw);
    if (!parsed) return null;
    loc = parsed;
  }
  return { v: 2, pairRef, code, daemonId, fingerprint, ...(loc ? { loc } : {}) };
}

export function parsePairingURL(raw: string, expectedOrigin: string): FragmentPairing | null {
  try {
    const url = new URL(raw, expectedOrigin);
    if (url.origin !== expectedOrigin || url.search) return null;
    if (url.pathname !== "/pair" && url.pathname !== "/pair/") return null;
    return parsePairingFragment(url.hash);
  } catch {
    return null;
  }
}
