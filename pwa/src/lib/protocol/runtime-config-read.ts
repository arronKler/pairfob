import { ProtocolError } from "./errors";
import type { LiveSession } from "./session-types";

type ConfigRead = { scope: string | null; pending: boolean; result: Promise<Record<string, unknown>> };
let reads = new WeakMap<LiveSession, ConfigRead>();

/** Retirement invalidates both accepted data and reads still owned by the old view. */
export function resetRuntimeConfigReads(): void { reads = new WeakMap(); }

/** Share the observer's read with a terminal opening before GetConfig has settled. */
export function readRuntimeConfig(session: LiveSession, refresh = false): Promise<Record<string, unknown>> {
  const scope = session.herdSession?.() ?? null;
  const current = reads.get(session);
  if (current && current.scope === scope && (!refresh || current.pending)) return current.result;
  let resolve!: (value: Record<string, unknown>) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
  const read: ConfigRead = { scope, pending: true, result };
  reads.set(session, read);
  const fail = (error: unknown) => {
    if (reads.get(session) === read) reads.delete(session);
    reject(error);
  };
  try {
    void session.getConfig().then(config => {
      if (reads.get(session) !== read || (session.herdSession?.() ?? null) !== scope) {
        fail(new ProtocolError("conflict", "runtime configuration belongs to a retired view"));
        return;
      }
      read.pending = false;
      resolve(config);
    }, fail);
  } catch (error) { fail(error); }
  return read.result;
}

/** Missing on old daemons means snapshot frames; malformed values never select raw mode. */
export function terminalUsesRawStream(config: Record<string, unknown>): boolean {
  const capabilities = config.capabilities;
  if (capabilities === undefined) return false;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw new ProtocolError("bad_result");
  const value = (capabilities as Record<string, unknown>).terminal_client_scroll;
  if (value !== undefined && typeof value !== "boolean") throw new ProtocolError("bad_result");
  return value === true;
}
