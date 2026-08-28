import { GRANT_ID_RE, DAEMON_ID_RE } from "./constants.ts";
import { randomHex, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { getDaemon, getGrantById, insertGrant, kickDaemonRow, listLiveDaemonIds, revokeGrantRow } from "./d1.ts";
import type { Env } from "./env.ts";
import { adminStatsBody } from "./metrics.ts";
import { bearerToken, buildOf, errorJson, jsonResponse, noStore, readJSON } from "./http.ts";

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

  if (path === "/v2/admin/grants" && req.method === "POST") {
    return mintGrant(req, env, now);
  }

  const revoke = /^\/v2\/admin\/grants\/([^/]+)\/revoke$/.exec(path);
  if (revoke && req.method === "POST") {
    const grantId = decodeURIComponent(revoke[1]);
    if (!GRANT_ID_RE.test(grantId)) return errorJson(build, 400, "bad_token", noStore());
    const ok = await revokeGrantRow(env.DB, grantId, now);
    const row = await getGrantById(env.DB, grantId);
    if (!row) return errorJson(build, 404, "bad_grant", noStore());
    return jsonResponse(build, 200, { ok: true, grant_id: grantId, revoked: ok || row.revoked_at != null }, noStore());
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

async function mintGrant(req: Request, env: Env, now: number): Promise<Response> {
  const build = buildOf(env);
  const body = (await readJSON(req)) ?? {};
  const label = typeof body.label === "string" ? body.label : null;
  const max = typeof body.max_daemons === "number" && body.max_daemons >= 1 && body.max_daemons <= 64 ? body.max_daemons : 2;
  const minted = await mintGrantRecord(env.DB, { label, max_daemons: max, now });
  return jsonResponse(
    build,
    200,
    { ok: true, grant_id: minted.grant_id, join_grant: minted.join_grant, max_daemons: max, label },
    noStore(),
  );
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

export async function mintGrantRecord(
  db: D1Database,
  opts: { label: string | null; max_daemons: number; now: number },
): Promise<{ grant_id: string; join_grant: string; grant_hash: string }> {
  const join_grant = "jg_" + randomHex(16);
  const grant_id = "g_" + randomHex(8);
  const grant_hash = await sha256Hex(join_grant);
  await insertGrant(db, {
    grant_id,
    grant_hash,
    max_daemons: opts.max_daemons,
    label: opts.label,
    created_at: opts.now,
  });
  return { grant_id, join_grant, grant_hash };
}
