import { DAEMON_ID_RE, PROTOCOL, RECONNECT_TOKEN_RE } from "./constants.ts";
import { sha256Hex } from "./crypto.ts";
import { getDaemon } from "./d1.ts";
import type { Env } from "./env.ts";
import { buildOf, errorJson, hasBrowserOrigin, jsonResponse, noStore, readJSON } from "./http.ts";
import { observeError } from "./metrics.ts";

export async function handleRekey(req: Request, env: Env): Promise<Response> {
  const build = buildOf(env);
  const store = noStore();
  if (req.method !== "POST") return errorJson(build, 405, "bad_token", store);
  if (hasBrowserOrigin(req)) return errorJson(build, 403, "forbidden", store);

  const body = await readJSON(req);
  const daemonId = typeof body?.daemon_id === "string" ? body.daemon_id : "";
  const oldToken = typeof body?.reconnect_token === "string" ? body.reconnect_token : "";
  const newToken = typeof body?.new_reconnect_token === "string" ? body.new_reconnect_token : "";
  if (
    !body ||
    body.v !== PROTOCOL ||
    !DAEMON_ID_RE.test(daemonId) ||
    !RECONNECT_TOKEN_RE.test(oldToken) ||
    !RECONNECT_TOKEN_RE.test(newToken) ||
    oldToken === newToken
  ) {
    observeError(env, "bad_token", daemonId);
    return errorJson(build, 400, "bad_token", store);
  }

  const row = await getDaemon(env.DB, daemonId);
  if (!row || row.kicked_at != null) {
    observeError(env, "bad_token", daemonId);
    return errorJson(build, 400, "bad_token", store);
  }
  const oldHash = await sha256Hex(oldToken);
  const newHash = await sha256Hex(newToken);

  const id = env.DAEMON_ROOM.idFromName(daemonId);
  let roomOk = false;
  let roomRejected = false;
  try {
    const res = await env.DAEMON_ROOM.get(id).fetch(
      new Request("https://pairfob.internal/internal/rekey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_hash: oldHash, new_hash: newHash }),
      }),
    );
    roomOk = res.ok;
    roomRejected = res.status === 400;
  } catch {
    roomOk = false;
  }
  if (!roomOk) {
    const code = roomRejected ? "bad_token" : "internal";
    observeError(env, code, daemonId);
    return errorJson(build, roomRejected ? 400 : 500, code, store);
  }

  return jsonResponse(build, 200, { ok: true, v: PROTOCOL, daemon_id: daemonId, reconnect_token: newToken }, store);
}
