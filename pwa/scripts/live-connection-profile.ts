/** Real relay/daemon profiling. Load the bundle on the relay's own origin with
 * a dedicated paired test device; never pass an active user's credential.
 * No simulated sockets, payload logging, mutations or automatic retries.
 */
import { profileUpgrade } from "./live-upgrade-profile.ts";
export { profileUpgrade } from "./live-upgrade-profile.ts";
import { connectSession } from "../src/lib/protocol/session-connect.ts";
import { connectionDiagnostics } from "../src/lib/protocol/connection-diagnostics.ts";
import { ProtocolError } from "../src/lib/protocol/errors.ts";
import { pairOverWS, type PairResult } from "../src/lib/protocol/pair-ws.ts";
import { sessionOverWS } from "../src/lib/protocol/session-ws.ts";
import type { LiveSession } from "../src/lib/protocol/session-types.ts";

export type LiveConnectionSample = {
  ok: boolean;
  code?: string;
  total_ms: number;
  authenticated_ms?: number;
  ping_ms?: number;
  reads: { op: string; ready_ms: number }[];
  stages: { event: string; elapsed_ms?: number; code?: string }[];
};

function relayURL(pair: PairResult): string {
  const url = new URL("/v2/ws", pair.relayOrigin);
  if (url.origin !== location.origin) throw new Error("Run the profiler on the paired relay's origin");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", "client");
  url.searchParams.set("daemon_id", pair.daemonId);
  return url.href;
}

/** One authentication, with the same first-flight config/snapshot as the app. */
export async function profileConnection(pair: PairResult, signal?: AbortSignal): Promise<LiveConnectionSample> {
  const url = relayURL(pair);
  const previous = connectionDiagnostics().filter(row => row.event === "connect_start").at(-1)?.connect_id;
  const started = performance.now();
  const sample: LiveConnectionSample = { ok: false, total_ms: 0, reads: [], stages: [] };
  let connection: Awaited<ReturnType<typeof connectSession>> | undefined;
  try {
    connection = await connectSession(url, pair, () => {}, signal, undefined, undefined, {
      reads: [{ op: "GetConfig", params: {} }, { op: "Snapshot", params: { session: null } }],
    });
    sample.authenticated_ms = performance.now() - started;
    await Promise.all(connection.reads.map(async read => {
      await read.answer;
      // This is application-observed availability, not the wire receive time.
      sample.reads.push({ op: read.op, ready_ms: performance.now() - started });
    }));
    sample.total_ms = performance.now() - started;
    const pingStarted = performance.now();
    await connection.transport.rpc("Ping", { t_ms: Date.now() });
    sample.ping_ms = performance.now() - pingStarted;
    sample.ok = true;
  } catch (error) {
    sample.total_ms = performance.now() - started;
    sample.code = error instanceof ProtocolError ? error.code : "error";
  } finally {
    connection?.transport.close();
    const diagnostics = connectionDiagnostics();
    const id = diagnostics.filter(row => row.event === "connect_start").at(-1)?.connect_id;
    if (id !== undefined && id !== previous) sample.stages = diagnostics.filter(row => row.connect_id === id)
      .map(({ event, elapsed_ms, code }) => ({ event, elapsed_ms, code }));
  }
  return sample;
}

/** Measure an already authenticated relay or P2P session without reopening it.
 * Space reads beyond the two-second title refresh window, so a short-lived
 * cache hit cannot masquerade as the cost of normal polling.
 */
export async function profileReads(session: LiveSession, count = 6): Promise<{ ping_ms: number; snapshot_ms: number }[]> {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("Choose 1–10 read samples");
  const rows: { ping_ms: number; snapshot_ms: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, 2200));
    const pingStarted = performance.now();
    await session.ping(Date.now());
    const ping_ms = performance.now() - pingStarted;
    const readStarted = performance.now();
    await session.snapshot();
    rows.push({ ping_ms, snapshot_ms: performance.now() - readStarted });
  }
  return rows;
}

// A bundle can be evaluated in a browser's DevTools/automation without adding
// this manual profiler or its pairing code to the production application.
Object.assign(globalThis, {
  pairfobLiveProfile: { profileConnection, profileReads, profileUpgrade, relayURL, sessionOverWS, pairOverWS, connectionDiagnostics },
});
