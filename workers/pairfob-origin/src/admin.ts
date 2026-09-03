import { DAEMON_ID_RE } from "./constants.ts";
import { timingSafeEqual } from "./crypto.ts";
import { getDaemon, kickDaemonRow, listLiveDaemonIds } from "./d1.ts";
import type { Env } from "./env.ts";
import { adminStatsBody } from "./metrics.ts";
import { bearerToken, buildOf, errorJson, jsonResponse, noStore } from "./http.ts";

function unauthorized(build: string): Response {
  return errorJson(build, 401, "forbidden", noStore());
}

function allowAdmin(req: Request, env: Env): boolean {
  if (!env.OPERATOR_TOKEN) return false;
  const tok = bearerToken(req);
  if (!tok) return false;
  return timingSafeEqual(tok, env.OPERATOR_TOKEN);
}

export async function handleAdmin(req: Request, env: Env, now = Date.now()): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/v2/admin/")) return null;
  const build = buildOf(env);
  if (!env.OPERATOR_TOKEN) return errorJson(build, 503, "internal", noStore());
  if (!allowAdmin(req, env)) return unauthorized(build);

  if (path === "/v2/admin/stats" && req.method === "GET") {
    const sample = await sampleLiveSockets(env);
    return jsonResponse(build, 200, adminStatsBody(sample.sockets, { rooms_sampled: sample.rooms, fwd_bytes: sample.fwdBytes, alarm_late_max_ms: sample.alarmLateMaxMs }), noStore());
  }

  const kick = /^\/v2\/admin\/daemons\/([^/]+)\/kick$/.exec(path);
  if (kick && req.method === "POST") {
    const daemonId = decodeURIComponent(kick[1]);
    if (!DAEMON_ID_RE.test(daemonId)) return errorJson(build, 400, "bad_token", noStore());
    const existing = await getDaemon(env.DB, daemonId);
    if (!existing) return errorJson(build, 404, "bad_token", noStore());
    try {
      const id = env.DAEMON_ROOM.idFromName(daemonId);
      const room = await env.DAEMON_ROOM.get(id).fetch(
        new Request("https://pairfob.internal/internal/kick", { method: "POST" }),
      );
      if (!room.ok) return errorJson(build, 503, "internal", noStore());
    } catch {
      return errorJson(build, 503, "internal", noStore());
    }
    const result = await kickDaemonRow(env.DB, daemonId, now);
    if (!result) return errorJson(build, 404, "bad_token", noStore());
    return jsonResponse(
      build,
      200,
      { ok: true, daemon_id: daemonId, kicked: result.kicked, grant_id: result.grant_id },
      noStore(),
    );
  }

  return errorJson(build, 404, "unbound", noStore());
}

async function sampleLiveSockets(env: Env): Promise<{ sockets: number; rooms: number; fwdBytes: number; alarmLateMaxMs: number }> {
  const ids = await listLiveDaemonIds(env.DB, 32);
  let sockets = 0;
  let rooms = 0;
  let fwdBytes = 0;
  let alarmLateMaxMs = 0;
  for (const daemonId of ids) {
    try {
      const res = await env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(daemonId)).fetch(
        new Request("https://pairfob.internal/internal/stats"),
      );
      if (!res.ok) continue;
      const body = (await res.json()) as {
        sockets?: number;
        fwd_bytes?: number;
        alarm_late_max_ms?: number;
      };
      rooms++;
      sockets += Number(body.sockets) || 0;
      fwdBytes += Number(body.fwd_bytes) || 0;
      const late = Number(body.alarm_late_max_ms) || 0;
      if (late > alarmLateMaxMs) alarmLateMaxMs = late;
    } catch {
      /* skip rooms that are not yet instantiated */
    }
  }
  return { sockets, rooms, fwdBytes, alarmLateMaxMs };
}
