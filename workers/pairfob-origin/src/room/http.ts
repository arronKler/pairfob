import { DAEMON_ID_RE, MAX_PENDING_HELLO } from "../constants.ts";
import { bytesToHex } from "../crypto.ts";
import { applySecurityHeaders, buildOf, errorJson, jsonResponse, noStore, readJSON, unpairedJson } from "../http.ts";
import type { RoomCore } from "./core.ts";
import type { Attachment } from "./attachment.ts";
import { armHello } from "./alarms.ts";

export interface UpgradeHooks {
  upgrade(att: Attachment, tags: string[], headers: Headers): Response;
}

export async function handleRoomFetch(
  room: RoomCore,
  req: Request,
  hooks?: UpgradeHooks,
  build = "dev",
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/internal/enroll" && req.method === "POST") {
    const body = await readJSON(req);
    const hash = typeof body?.reconnect_hash === "string" ? body.reconnect_hash : "";
    const grantId = typeof body?.grant_id === "string" ? body.grant_id : "";
    const daemonId = typeof body?.daemon_id === "string" ? body.daemon_id : "";
    if (!hash || !grantId) return errorJson(build, 400, "bad_token");
    if (daemonId && daemonId !== room.daemonId) return errorJson(build, 400, "bad_token");
    const r = room.enroll({ reconnect_hash: hash, grant_id: grantId });
    return r.ok ? jsonResponse(build, 200, { ok: true }) : errorJson(build, 409, "internal");
  }

  if (path === "/internal/rekey" && req.method === "POST") {
    const body = await readJSON(req);
    const oldHash = typeof body?.old_hash === "string" ? body.old_hash : "";
    const newHash = typeof body?.new_hash === "string" ? body.new_hash : "";
    if (!oldHash || !newHash) return errorJson(build, 400, "bad_token");
    const r = room.rekey(oldHash, newHash);
    return r.ok ? jsonResponse(build, 200, { ok: true }) : errorJson(build, 400, "bad_token");
  }

  if (path === "/internal/verify-enroll" && req.method === "POST") {
    const body = await readJSON(req);
    const hash = typeof body?.reconnect_hash === "string" ? body.reconnect_hash : "";
    const grantId = typeof body?.grant_id === "string" ? body.grant_id : "";
    if (!hash || !grantId) return errorJson(build, 400, "bad_token");
    const r = room.verifyEnroll(hash, grantId);
    return r.ok ? jsonResponse(build, 200, { ok: true }) : errorJson(build, 400, "bad_token");
  }

  if (path === "/internal/abort-enroll" && req.method === "POST") {
    const body = await readJSON(req);
    const hash = typeof body?.reconnect_hash === "string" ? body.reconnect_hash : "";
    const grantId = typeof body?.grant_id === "string" ? body.grant_id : "";
    if (!hash || !grantId) return errorJson(build, 400, "bad_token");
    const r = room.abortEnroll(hash, grantId);
    return r.ok ? jsonResponse(build, 200, { ok: true }) : errorJson(build, 409, "internal");
  }

  if (path === "/internal/kick" && req.method === "POST") {
    room.kick();
    return jsonResponse(build, 200, { ok: true });
  }

  if (path === "/internal/issue-ticket" && req.method === "POST") {
    const body = await readJSON(req);
    const loc = typeof body?.pair_loc === "string" ? body.pair_loc : "";
    const r = await room.issueTicket(loc);
    if (!r.ok) return unpairedJson(build, noStore());
    return jsonResponse(build, 200, { ok: true, pair_ticket: r.pair_ticket, pair_ref: r.pair_ref, expires_in: 15 }, noStore());
  }

  if (path === "/internal/stats" && req.method === "GET") {
    return jsonResponse(build, 200, {
      ok: true,
      sockets: room.sockets().length,
      kinds: room.countKinds(),
      fwd_bytes: room.fwdBytes,
      closes: room.closeCount,
      alarm_late_max_ms: room.alarmLateMaxMs,
      alarm_late_count: room.alarmLateCount,
    });
  }

  const upgrade = (req.headers.get("Upgrade") || "").toLowerCase() === "websocket" || path === "/v2/ws";
  if (upgrade && req.method === "GET") {
    const role = url.searchParams.get("role") || "";
    const daemonId = url.searchParams.get("daemon_id") || "";
    if (url.searchParams.has("pair_loc")) return unpairedJson(build, noStore());
    if (role !== "daemon" && role !== "client") return errorJson(build, 400, "bad_token", noStore());
    if (!DAEMON_ID_RE.test(daemonId) || daemonId !== room.daemonId) {
      return errorJson(build, 400, "bad_token", noStore());
    }
    if (room.countPendingHellos() >= MAX_PENDING_HELLO) {
      return errorJson(build, 429, "rate_limited", noStore());
    }
    const consumed = room.consumeUpgrade(url.searchParams, role);
    if (!consumed.ok) return unpairedJson(build, noStore());
    if (!hooks) return errorJson(build, 500, "internal", noStore());
    await armHello(room, bytesToHex(room.random(8)), consumed.attachment.created_ms);
    const headers = new Headers({ "Sec-WebSocket-Protocol": "pairfob.v2" });
    applySecurityHeaders(headers, build);
    return hooks.upgrade(consumed.attachment, consumed.tags, headers);
  }

  return errorJson(build, 404, "unbound");
}

void buildOf;
