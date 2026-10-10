import { isRegisteredDaemon, readAttachment, type Attachment } from "./attachment.ts";
import { diagnosticLog, diagnosticsEnabled, type DiagnosticsEnv } from "./diagnostics.ts";

type Fields = Record<string, string | number | boolean>;

/** Low-frequency lifecycle events use the same opt-in expiry as sampled frame traces. */
export function lifecycleLog(env: DiagnosticsEnv, objectId: string, event: string, fields: () => Fields): void {
  if (!diagnosticsEnabled(env, Date.now(), () => 0)) return;
  try {
    diagnosticLog(env, objectId, { event, at_ms: Date.now(), ...fields() });
  } catch {
    // Reading diagnostic metadata must not affect connection handling.
  }
}

export function socketFields(att: Attachment | null, readyState: number): Fields {
  return {
    role: att?.role ?? "unknown",
    bind_kind: att?.kind ?? "unknown",
    registered: isRegisteredDaemon(att),
    retired: att?.retired === true,
    socket_state: readyState,
    created_ms: att?.created_ms ?? 0,
    hello_at_ms: att?.hello_at_ms ?? 0,
  };
}

/** Counts include retired runtime sockets, which the routing layer intentionally hides. */
export function socketCounts(sockets: WebSocket[]): Fields {
  let registered = 0, pending = 0, retired = 0, closing = 0;
  for (const socket of sockets) {
    const att = readAttachment(socket.deserializeAttachment());
    if (att?.retired) retired++;
    else if (isRegisteredDaemon(att)) registered++;
    else if (att?.mode === "hello" && att.kind === "none") pending++;
    if (socket.readyState === 2) closing++;
  }
  return {
    runtime_sockets: sockets.length,
    registered_daemons: registered,
    pending_hellos: pending,
    retired_sockets: retired,
    closing_sockets: closing,
  };
}

/** No timers or I/O; preserve synchronous dispatch and rejection identity. */
export function traceLifecycle(
  env: DiagnosticsEnv,
  objectId: string,
  event: string,
  fields: () => Fields,
  work: () => void | Promise<void>,
): void | Promise<void> {
  if (!diagnosticsEnabled(env, Date.now(), () => 0)) return work();
  const started = Date.now();
  const emit = (phase: string) => lifecycleLog(env, objectId, event,
    () => ({ ...fields(), phase, started_ms: started, elapsed_ms: Math.max(0, Date.now() - started) }));
  emit("start");
  try {
    const result = work();
    if (result) return result.then(() => { emit("end"); }, (error: unknown) => { emit("error"); throw error; });
    emit("end");
  } catch (error) {
    emit("error");
    throw error;
  }
}
