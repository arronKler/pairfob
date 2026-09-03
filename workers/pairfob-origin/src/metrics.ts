import { DAEMON_ID_RE, GRANT_ID_RE } from "./constants.ts";
import { buildOf } from "./http.ts";

export type CounterMap = Record<string, number>;

export type AnalyticsSink = {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: (string | null)[];
    doubles?: number[];
  }): void;
};

export type MetricsEnv = {
  METRICS?: AnalyticsSink;
  BUILD?: string;
};

export type RoomMetrics = {
  bind(kind: string): void;
  close(code: string, kind: string): void;
  fwd(bytes: number): void;
  alarmLate(ms: number): void;
};

/**
 * Dataset: pairfob
 *
 * index1: daemon_id when known (high cardinality); empty for anonymous beacons
 * blob1: event  blob2: result  blob3: dim  blob4: extra  blob5: build
 * double1: count  double2: bytes  double3: ms
 */
const counters: CounterMap = Object.create(null) as CounterMap;

const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SECRET_RE = /\b(?:jg_|rt_|it_)[0-9a-f]+\b/i;
const SECRET_KEY_RE = /pair_ticket|reconnect_token|join_grant|new_reconnect_token/i;

export function sanitizeLabel(value: string | undefined): string {
  if (!value) return "";
  if (SECRET_RE.test(value) || SECRET_KEY_RE.test(value)) return "redacted";
  if (!LABEL_RE.test(value)) return "invalid";
  return value;
}

export function sanitizeIndex(value: string | undefined): string {
  const label = sanitizeLabel(value);
  if (DAEMON_ID_RE.test(label) || GRANT_ID_RE.test(label)) return label;
  return "";
}

export function inc(name: string, n = 1): void {
  counters[name] = (counters[name] ?? 0) + n;
}

export function snapshot(): CounterMap {
  return { ...counters };
}

export function resetMetrics(): void {
  for (const k of Object.keys(counters)) delete counters[k];
}

type Point = {
  event: string;
  result?: string;
  dim?: string;
  extra?: string;
  daemonId?: string;
  n?: number;
  bytes?: number;
  ms?: number;
  log?: boolean;
};

function emit(env: MetricsEnv | undefined, point: Point): void {
  const event = sanitizeLabel(point.event) || "invalid";
  const result = sanitizeLabel(point.result);
  const dim = sanitizeLabel(point.dim);
  inc(event, point.n ?? 1);
  if (result) inc(`${event}.${result}`, point.n ?? 1);
  else if (dim) inc(`${event}.${dim}`, point.n ?? 1);
  const blobs = [event, result, dim, sanitizeLabel(point.extra), sanitizeLabel(buildOf(env ?? {}))];
  env?.METRICS?.writeDataPoint({
    indexes: [sanitizeIndex(point.daemonId)],
    blobs,
    doubles: [point.n ?? 1, point.bytes ?? 0, point.ms ?? 0],
  });
  if (point.log === false || env?.BUILD === "test") return;
  console.log(
    JSON.stringify({
      kind: "pairfob",
      event,
      result,
      dim: sanitizeLabel(point.dim),
      extra: sanitizeLabel(point.extra),
    }),
  );
}

export function observeUpgrade(env: MetricsEnv, role: string, daemonId = ""): void {
  emit(env, { event: "ws_open", dim: role, daemonId });
}

export function observeEnroll(env: MetricsEnv, result: string, daemonId = ""): void {
  emit(env, { event: "enroll", result, daemonId });
}

export function observeIntent(env: MetricsEnv, result: "ok" | "unpaired" | "rate_limited", daemonId = ""): void {
  emit(env, { event: "pair_intent", result, daemonId });
}

export function observeError(env: MetricsEnv, code: string, daemonId = ""): void {
  emit(env, { event: "error", result: code, extra: code, daemonId });
}

export function observePage(env: MetricsEnv, pathClass: string): void {
  emit(env, { event: "page", dim: pathClass });
}

export function observeBeacon(env: MetricsEnv, name: string, result = "", extra = ""): void {
  emit(env, { event: name, result, extra });
}

export function observeFwd(env: MetricsEnv, bytes: number, daemonId = ""): void {
  inc("fwd_frames");
  counters.fwd_bytes = (counters.fwd_bytes ?? 0) + bytes;
  emit(env, { event: "fwd", daemonId, n: 1, bytes, log: false });
}

export function observeClose(env: MetricsEnv, code: string, kind: string, daemonId = ""): void {
  emit(env, { event: "ws_close", result: code || "unknown", dim: kind, daemonId });
}

export function observeBind(env: MetricsEnv, kind: string, daemonId = ""): void {
  emit(env, { event: "bind", dim: kind, daemonId });
}

export function observeAlarmLate(env: MetricsEnv, ms: number, daemonId = ""): void {
  inc("alarm_late_count");
  counters.alarm_late_sum_ms = (counters.alarm_late_sum_ms ?? 0) + ms;
  const prev = counters.alarm_late_max_ms ?? 0;
  if (ms > prev) counters.alarm_late_max_ms = ms;
  emit(env, { event: "alarm_late", daemonId, ms, log: ms >= 1_000 });
}

export function roomMetrics(env: MetricsEnv, daemonId: string): RoomMetrics {
  return {
    bind(kind) {
      observeBind(env, kind, daemonId);
    },
    close(code, kind) {
      observeClose(env, code, kind, daemonId);
    },
    fwd(bytes) {
      observeFwd(env, bytes, daemonId);
    },
    alarmLate(ms) {
      observeAlarmLate(env, ms, daemonId);
    },
  };
}

export function adminStatsBody(
  sampledWs: number | null = null,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: true,
    counters: snapshot(),
    sampled_ws: sampledWs,
    note: "isolate counters are per-Worker; durable series are Analytics Engine dataset pairfob. live websocket count is sampled from Durable Object getWebSockets()",
    ...extra,
  };
}
