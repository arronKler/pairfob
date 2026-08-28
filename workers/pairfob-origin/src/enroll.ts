import {
  DAEMON_ID_RE,
  JOIN_GRANT_RE,
  OPEN_ENROLL_MAX_DAEMONS,
  PROTOCOL,
  RECONNECT_TOKEN_RE,
  SELF_GRANT_PER_IP,
  SELF_GRANT_WINDOW_MS,
} from "./constants.ts";
import { hmacSha256Hex, randomHex, sha256Hex } from "./crypto.ts";
import {
  classifyCasMiss,
  compensateEnroll,
  enrollDaemonBatch,
  getDaemon,
  getGrantByHash,
  getGrantById,
  insertSelfServeGrant,
  type GrantRow,
} from "./d1.ts";
import type { Env } from "./env.ts";
import { buildOf, clientIP, errorJson, hasBrowserOrigin, jsonResponse, noStore, readJSON } from "./http.ts";
import { allowEnrollIP } from "./limits.ts";
import { observeEnroll, observeError } from "./metrics.ts";

export async function handleEnroll(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const build = buildOf(env);
  const store = noStore();
  if (req.method !== "POST") return errorJson(build, 405, "bad_token", store);
  if (hasBrowserOrigin(req)) return errorJson(build, 403, "forbidden", store);
  if (env.ENROLL_OPEN === "0") return errorJson(build, 403, "forbidden", store);
  if (!env.IP_HASH_PEPPER) return errorJson(build, 500, "internal", store);

  const ip = clientIP(req);
  if (!allowEnrollIP(ip, now)) {
    observeEnroll(env, "rate_limited");
    observeError(env, "rate_limited");
    return errorJson(build, 429, "rate_limited", store);
  }

  const body = await readJSON(req);
  const join = typeof body?.join_grant === "string" ? body.join_grant : "";
  const daemonId = typeof body?.daemon_id === "string" ? body.daemon_id : "";
  const reconnectToken = typeof body?.reconnect_token === "string" ? body.reconnect_token : "";
  if (!body || body.v !== PROTOCOL || !DAEMON_ID_RE.test(daemonId) || !RECONNECT_TOKEN_RE.test(reconnectToken)) {
    observeEnroll(env, "bad_token", daemonId);
    return errorJson(build, 400, "bad_token", store);
  }
  const reconnectHash = await sha256Hex(reconnectToken);

  const existing = await getDaemon(env.DB, daemonId);
  if (existing) {
    let recovered = existing.kicked_at == null &&
      await verifyRoomEnroll(env, daemonId, reconnectHash, existing.grant_id);
    // D1-only crash: finish Room with the same reconnect hash. Possession of
    // daemon_id + reconnect_token is enough; join_grant is optional compatibility.
    if (!recovered && existing.kicked_at == null && await mayFinishRoom(env, join, existing.grant_id)) {
      recovered = await enrollRoom(env, daemonId, reconnectHash, existing.grant_id);
    }
    if (!recovered) {
      observeEnroll(env, "bad_token", daemonId);
      return errorJson(build, 400, "bad_token", store);
    }
    observeEnroll(env, "ok_retry", daemonId);
    return enrollSuccess(build, daemonId, reconnectToken, existing.grant_id, store);
  }

  const resolved = await resolveGrant(env, join, ip, now, build, store, daemonId);
  if ("response" in resolved) return resolved.response;
  const grant = resolved.grant;

  const enrollIpHash = await hmacSha256Hex(env.IP_HASH_PEPPER, ip);

  let changes = 0;
  try {
    changes = await enrollDaemonBatch(env.DB, {
      daemon_id: daemonId,
      grant_id: grant.grant_id,
      created_at: now,
      enroll_ip_hash: enrollIpHash,
    });
  } catch {
    observeEnroll(env, "internal", daemonId);
    return errorJson(build, 500, "internal", store);
  }
  if (changes !== 1) {
    const again = (await getGrantById(env.DB, grant.grant_id)) ?? grant;
    const code = classifyCasMiss(again, now);
    observeEnroll(env, code, daemonId);
    const status = code === "rate_limited" ? 429 : code === "grant_exhausted" ? 409 : 400;
    return errorJson(build, status, code, store);
  }

  const roomRes = await enrollRoom(env, daemonId, reconnectHash, grant.grant_id);
  if (!roomRes) {
    await abortRoomEnroll(env, daemonId, reconnectHash, grant.grant_id);
    await compensateEnroll(env.DB, grant.grant_id, daemonId);
    observeEnroll(env, "internal", daemonId);
    return errorJson(build, 500, "internal", store);
  }

  observeEnroll(env, "ok", daemonId);
  return enrollSuccess(build, daemonId, reconnectToken, grant.grant_id, store);
}

function enrollSuccess(
  build: string,
  daemonId: string,
  reconnectToken: string,
  grantId: string,
  headers: Record<string, string>,
): Response {
  return jsonResponse(build, 200, {
    ok: true, v: PROTOCOL, daemon_id: daemonId, reconnect_token: reconnectToken, grant_id: grantId,
  }, headers);
}

async function mayFinishRoom(env: Env, join: string, grantId: string): Promise<boolean> {
  if (join === "") return true;
  if (!JOIN_GRANT_RE.test(join)) return false;
  const retryGrant = await getGrantByHash(env.DB, await sha256Hex(join));
  return retryGrant?.grant_id === grantId && retryGrant.revoked_at == null;
}

async function resolveGrant(
  env: Env,
  join: string,
  ip: string,
  now: number,
  build: string,
  store: Record<string, string>,
  daemonId: string,
): Promise<{ grant: GrantRow } | { response: Response }> {
  if (JOIN_GRANT_RE.test(join)) {
    const grant = await getGrantByHash(env.DB, await sha256Hex(join));
    if (!grant || grant.revoked_at != null) {
      observeEnroll(env, "bad_grant", daemonId);
      return { response: errorJson(build, 400, "bad_grant", store) };
    }
    return { grant };
  }
  if (join !== "") {
    observeEnroll(env, "bad_grant", daemonId);
    return { response: errorJson(build, 400, "bad_grant", store) };
  }
  const grantId = await mintOpenGrant(env, ip, now);
  if (grantId === "rate_limited") {
    observeEnroll(env, "rate_limited", daemonId);
    observeError(env, "rate_limited", daemonId);
    return { response: errorJson(build, 429, "rate_limited", store) };
  }
  if (!grantId) {
    observeEnroll(env, "internal", daemonId);
    return { response: errorJson(build, 500, "internal", store) };
  }
  const grant = await getGrantById(env.DB, grantId);
  if (!grant) {
    observeEnroll(env, "internal", daemonId);
    return { response: errorJson(build, 500, "internal", store) };
  }
  return { grant };
}

/** Internal 1-slot grant. The minted jg_ is never returned to the client. */
async function mintOpenGrant(env: Env, ip: string, now: number): Promise<string | "rate_limited" | null> {
  const grantId = "g_" + randomHex(8);
  try {
    const claimed = await insertSelfServeGrant(env.DB, {
      grant_id: grantId,
      grant_hash: await sha256Hex("jg_" + randomHex(16)),
      ip_hash: await hmacSha256Hex(env.IP_HASH_PEPPER, ip),
      max_daemons: OPEN_ENROLL_MAX_DAEMONS,
      label: "open-enroll",
      created_at: now,
      window_start: now - SELF_GRANT_WINDOW_MS,
      quota: SELF_GRANT_PER_IP,
    });
    return claimed ? grantId : "rate_limited";
  } catch {
    return null;
  }
}

async function abortRoomEnroll(env: Env, daemonId: string, reconnectHash: string, grantId: string): Promise<void> {
  try {
    const id = env.DAEMON_ROOM.idFromName(daemonId);
    await env.DAEMON_ROOM.get(id).fetch(
      new Request("https://pairfob.internal/internal/abort-enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reconnect_hash: reconnectHash, grant_id: grantId }),
      }),
    );
  } catch {
    /* best effort cleanup after an uncertain enroll response */
  }
}

async function enrollRoom(env: Env, daemonId: string, reconnectHash: string, grantId: string): Promise<boolean> {
  try {
    const id = env.DAEMON_ROOM.idFromName(daemonId);
    const res = await env.DAEMON_ROOM.get(id).fetch(
      new Request("https://pairfob.internal/internal/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reconnect_hash: reconnectHash, grant_id: grantId, daemon_id: daemonId }),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function verifyRoomEnroll(env: Env, daemonId: string, reconnectHash: string, grantId: string): Promise<boolean> {
  try {
    const id = env.DAEMON_ROOM.idFromName(daemonId);
    const res = await env.DAEMON_ROOM.get(id).fetch(
      new Request("https://pairfob.internal/internal/verify-enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reconnect_hash: reconnectHash, grant_id: grantId }),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}
