import { DAEMON_ID_RE, PROTOCOL, RECONNECT_TOKEN_RE } from "../constants.ts";
import { isZeroRoute, timingSafeEqual } from "../crypto.ts";
import { Typ, type Frame } from "../envelope.ts";
import { parseJSONObject, reject, sendErr, sendJSON } from "../frames.ts";
import { sha256Hex } from "../crypto.ts";
import { settleHello } from "./alarms.ts";
import type { RoomCore } from "./core.ts";
import { newAttachment } from "./attachment.ts";
import type { RoomSocket } from "./types.ts";

/**
 * A refused hello dies before any session exists, so the client cannot report
 * the code afterwards. Recording it here is the only way a registration loop
 * shows up in Analytics Engine.
 */
function refuseDaemon(room: RoomCore, ws: RoomSocket, code: string, message: string): void {
  room.noteReject(code, "daemon");
  reject(ws, code, message);
}

export async function handleDaemonHello(room: RoomCore, ws: RoomSocket, frame: Frame): Promise<void> {
  if (!isZeroRoute(frame.routeId)) {
    refuseDaemon(room, ws, "bad_token", "HELLO_DAEMON route_id must be zero");
    return;
  }
  const req = parseJSONObject(frame.payload);
  const daemonId = typeof req?.daemon_id === "string" ? req.daemon_id : "";
  const token = typeof req?.reconnect_token === "string" ? req.reconnect_token : "";
  if (
    !req ||
    req.v !== PROTOCOL ||
    req.op !== "RegisterDaemon" ||
    typeof req.join_token === "string" && req.join_token !== "" ||
    !DAEMON_ID_RE.test(daemonId) ||
    daemonId !== room.daemonId ||
    !RECONNECT_TOKEN_RE.test(token)
  ) {
    refuseDaemon(room, ws, "bad_token", "invalid RegisterDaemon payload");
    return;
  }

  const att = room.att(ws);
  if (att?.role !== "daemon") {
    refuseDaemon(room, ws, "unbound", "HELLO_DAEMON on non-daemon websocket");
    return;
  }
  if (room.daemon === ws) {
    room.noteReject("unbound", "daemon");
    sendErr(ws, "unbound", "daemon websocket already registered");
    ws.close(1000, "unbound");
    return;
  }

  const want = room.loadReconnectHash();
  if (!want) {
    refuseDaemon(room, ws, "enroll_required", "room has no reconnect hash");
    return;
  }
  const got = await sha256Hex(token);
  if (!timingSafeEqual(got, want)) {
    refuseDaemon(room, ws, "bad_token", "reconnect");
    return;
  }

  if (room.daemon && room.daemon !== ws) {
    room.notifyReplaced();
    room.daemon.close(1000, "replaced");
  }

  room.daemon = ws;
  const next = newAttachment("daemon", room.now(), { hello_at_ms: room.now() });
  room.writeAtt(ws, next);
  sendJSON(ws, Typ.HELLO_DAEMON, frame.routeId, {
    v: PROTOCOL,
    op: "RegisterDaemon",
    ok: true,
    daemon_id: room.daemonId,
    reconnect_token: token,
    relay_time: Math.floor(room.now() / 1000),
  });
  await settleHello(room);
}
