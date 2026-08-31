import { ProtocolError } from "./protocol/errors.ts";
import { hasCopy, t, type CopyKey } from "./i18n.ts";

const FRIENDLY_CODES = [
  "unpaired",
  "locator_required",
  "invalid_pair_code",
  "bad_pair_code",
  "pair_timeout",
  "pairing_replaced",
  "pairing_expired",
  "sas_required",
  "pairing_cancelled",
  "rate_limited",
  "timeout",
  "heartbeat_timeout",
  "fp_mismatch",
  "bad_relay",
  "pair_busy",
  "invalid_pair_ref",
  "daemon_offline",
  "ws_open_failed",
  "revoked",
  "herdr_offline",
  "kicked",
  "too_many_devices",
  "unbound",
  "wrong_ws",
  "wrong_protocol",
  "enroll_required",
  "index_unavailable",
  "daemon_replaced",
  "reconnecting",
  "disconnected",
  "pane_not_found",
  "tab_not_found",
  "workspace_not_found",
  "stale_prompt",
  "invalid_key",
  "unknown_outcome",
  "partial_failure",
  "conflict",
  "unsupported",
  "agent_not_found",
  "worktree_not_found",
  "transcript_unavailable",
  "forbidden",
  "invalid_argument",
  "unknown_op",
  "too_large",
  "backpressure",
  "replay",
  "bad_token",
  "bad_frame",
  "bad_message",
  "internal",
  "bad_proof",
  "bad_signature",
  "invalid_credential",
  "bad_grant",
  "grant_exhausted",
] as const;

const FRIENDLY_SET = new Set<string>(FRIENDLY_CODES);

function errorCopy(code: string): string | undefined {
  const key = `err.${code}`;
  if (!FRIENDLY_SET.has(code) || !hasCopy(key)) return undefined;
  return t(key as CopyKey);
}

/** Fail-closed copy when a public code has no specific next step. */
export function genericNotice(): string {
  return t("err.generic");
}

/** Live lookup so language switches stay in sync. */
export const GENERIC_NOTICE: string = new Proxy(Object.create(null) as String, {
  get(_target, prop, receiver) {
    const value = genericNotice();
    if (prop === Symbol.toPrimitive) return () => value;
    if (prop === "valueOf" || prop === "toString") return () => value;
    const found = Reflect.get(Object(value), prop, receiver);
    return typeof found === "function" ? found.bind(value) : found;
  },
}) as unknown as string;

/** User-visible next steps for every public protocol / mux / RPC / enroll code. */
export const FRIENDLY_ERROR: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_target, prop) {
    if (typeof prop !== "string") return undefined;
    return errorCopy(prop);
  },
  has(_target, prop) {
    return typeof prop === "string" && FRIENDLY_SET.has(prop);
  },
  ownKeys() {
    return FRIENDLY_CODES.slice();
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== "string" || !FRIENDLY_SET.has(prop)) return undefined;
    return { enumerable: true, configurable: true, value: errorCopy(prop) };
  },
});

export function noticeFor(code: string): string {
  if (!code) return genericNotice();
  return errorCopy(code) || genericNotice();
}

export function messageOf(error: unknown, context: "mutation" | "read" = "mutation"): string {
  if (error instanceof ProtocolError) {
    if (context === "read" && error.code === "too_large") return t("err.readTooLarge");
    return noticeFor(error.code);
  }
  return genericNotice();
}

/** Live session chrome copy. Never surfaces mux ERROR.message. */
export function sessionEventNotice(event: { type: string; code?: string; message?: string }): string {
  if (event.type === "connected" || event.type === "poke") return "";
  const mapped = event.code ? errorCopy(event.code) : undefined;
  if (mapped) return mapped;
  if (event.type === "reconnecting") return t("err.reconnecting");
  if (event.type === "disconnected") return t("err.disconnected");
  return genericNotice();
}
