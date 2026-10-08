// Bounded metadata only. Never decode control JSON or inspect FWD payloads here.
import { ENVELOPE_VERSION, HEADER_SIZE, Typ } from "../envelope.ts";
import { sanitizeLabel } from "../metrics.ts";

export interface DiagnosticsEnv {
  BUILD?: string;
  ROOM_DIAGNOSTICS_SAMPLE_RATE?: string;
  ROOM_DIAGNOSTICS_UNTIL?: string;
}

const frameNames = new Map<number, string>(Object.entries(Typ).map(([name, typ]) => [typ, name]));
const closeReasons = new Set([
  "closed", "replaced", "kicked", "daemon_offline", "unpaired", "unbound",
  "pair_timeout", "pairing_expired", "bad_frame", "normal", "shutdown",
]);

export function closeReason(reason: string): string {
  return reason === "" ? "empty" : closeReasons.has(reason) ? reason : "other";
}

export function frameLabel(message: string | ArrayBuffer): string {
  if (typeof message === "string") return "text";
  if (message.byteLength < HEADER_SIZE) return "short";
  const header = new Uint8Array(message, 0, HEADER_SIZE);
  if (header[0] !== ENVELOPE_VERSION) return "invalid_version";
  return frameNames.get(header[1]) ?? "unknown";
}

export function diagnosticsEnabled(env: DiagnosticsEnv, now = Date.now(), random = Math.random): boolean {
  const rate = Number(env.ROOM_DIAGNOSTICS_SAMPLE_RATE ?? 0);
  const until = Date.parse(env.ROOM_DIAGNOSTICS_UNTIL ?? "");
  return Number.isFinite(rate) && rate > 0 && rate <= 1 && Number.isFinite(until)
    && now < until && random() < rate;
}

type Fields = Record<string, string | number | boolean>;

export function diagnosticLog(env: DiagnosticsEnv, objectId: string, fields: Fields): void {
  if (env.BUILD === "test") return;
  // Only the platform's opaque ID is allowed, never a client supplied identifier.
  const object_id = /^[0-9a-f]{64}$/.test(objectId) ? objectId : "";
  try {
    console.log(JSON.stringify({ kind: "pairfob", build: sanitizeLabel(env.BUILD), object_id, ...fields }));
  } catch {
    // Diagnostics must not turn a successfully handled frame into a failed event.
  }
}

/** Preserve synchronous returns and rejection identity; no timers, storage or waitUntil. */
export function traceHandler(
  env: DiagnosticsEnv,
  objectId: string,
  frame: string,
  role: string,
  work: () => void | Promise<void>,
): void | Promise<void> {
  if (!diagnosticsEnabled(env)) return work();
  const start = Date.now();
  const event_id = crypto.randomUUID();
  const base = { event: "room_handler", event_id, frame, role };
  diagnosticLog(env, objectId, { ...base, phase: "start", at_ms: start });
  const finish = (phase: string) => diagnosticLog(env, objectId, {
    ...base, phase, at_ms: Date.now(), elapsed_ms: Math.max(0, Date.now() - start),
  });
  try {
    const result = work();
    if (result) return result.then(() => { finish("end"); }, (error: unknown) => { finish("error"); throw error; });
    finish("end");
  } catch (error) {
    finish("error");
    throw error;
  }
}
