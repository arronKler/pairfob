import { DAEMON_ID_RE, HELLO_GRACE_MS, MAX_ESTABLISHED, MAX_RESUME, PROTOCOL } from "../constants.ts";
import { isZeroRoute, newRouteId, routeHex } from "../crypto.ts";
import { encode, Typ, type Frame } from "../envelope.ts";
import { parseJSONObject, reject, sendErr, sendJSON } from "../frames.ts";
import { armHello, armResume, clearKindRef } from "./alarms.ts";
import type { RoomCore } from "./core.ts";
import type { RoomSocket } from "./types.ts";

export async function handleClientHello(room: RoomCore, ws: RoomSocket, frame: Frame): Promise<void> {
  if (!isZeroRoute(frame.routeId)) {
    reject(ws, "bad_token", "HELLO_CLIENT route_id must be zero");
    return;
  }
  const req = parseJSONObject(frame.payload);
  if (!req || req.v !== PROTOCOL || req.protocol !== PROTOCOL) {
    reject(ws, "bad_token", "invalid HELLO_CLIENT payload");
    return;
  }
  const att = room.att(ws);
  if (!att || att.role !== "phone") {
    reject(ws, "unbound", "HELLO_CLIENT on non-phone websocket");
    return;
  }
  if (att.hello_at_ms && att.mode === "hello" && att.kind === "none") {
    sendErr(ws, "unbound", "duplicate HELLO_CLIENT");
    ws.close(1000, "unbound");
    return;
  }
  const now = room.now();
  att.hello_at_ms = now;
  att.mode = "hello";
  room.writeAtt(ws, att);
  await armHello(room, String(now), now);
}

export async function handleSessionAttach(room: RoomCore, ws: RoomSocket, frame: Frame): Promise<void> {
  if (!isZeroRoute(frame.routeId)) {
    reject(ws, "bad_token", "invalid SESSION_ATTACH payload");
    return;
  }
  const req = parseJSONObject(frame.payload);
  const daemonId = typeof req?.daemon_id === "string" ? req.daemon_id : "";
  if (!req || req.v !== PROTOCOL || !DAEMON_ID_RE.test(daemonId)) {
    reject(ws, "bad_token", "invalid SESSION_ATTACH payload");
    return;
  }
  const att = room.att(ws);
  if (!att || att.role !== "phone") {
    reject(ws, "unbound", "SESSION_ATTACH on non-phone websocket");
    return;
  }
  if (!att.hello_at_ms || room.now() - att.hello_at_ms > HELLO_GRACE_MS) {
    sendErr(ws, "unbound", "SESSION_ATTACH after HELLO timeout");
    ws.close(1000, "unbound");
    return;
  }
  if (att.mode === "pairing" || att.kind === "pairing") {
    sendErr(ws, "wrong_ws", "SESSION_ATTACH on PairingWS");
    return;
  }
  if (att.kind === "resumehello" || att.kind === "established" || att.mode === "session") {
    sendErr(ws, "wrong_ws", "SessionWS already attached");
    return;
  }
  if (daemonId !== room.daemonId) {
    reject(ws, "bad_frame", "SESSION_ATTACH daemon_id mismatch");
    return;
  }
  if (!room.daemon) {
    sendErr(ws, "daemon_offline", "no daemon");
    return;
  }

  const { resume } = room.countKinds();
  if (resume >= MAX_RESUME) {
    const lru = room.lruResume();
    if (lru) room.closeBind(lru, "kicked", "replaced LRU ResumeHello");
  }

  const rid = newRouteId((n) => room.random(n));
  const hex = routeHex(rid);
  const now = room.now();
  att.mode = "session";
  att.kind = "resumehello";
  att.route_id = hex;
  att.created_ms = now;
  room.writeAtt(ws, att);
  room.store.upsertBind({ route_id: hex, kind: "resumehello", created_at: now, pair_ref: "" });
  room.noteBind("resumehello");
  await armResume(room, hex, now);

  const body = { v: PROTOCOL, route_id: hex };
  sendJSON(ws, Typ.SESSION_BOUND, rid, body);
  sendJSON(room.daemon, Typ.SESSION_BOUND, rid, body);
}

export async function handleSessionEstablished(room: RoomCore, ws: RoomSocket, frame: Frame): Promise<void> {
  if (room.daemon !== ws) return;
  const req = parseJSONObject(frame.payload);
  const want = routeHex(frame.routeId);
  const got = typeof req?.route_id === "string" ? req.route_id : "";
  if (isZeroRoute(frame.routeId) || !req || req.v !== PROTOCOL || got !== want) {
    sendErr(ws, "unbound", "SESSION_ESTABLISHED route mismatch", { routeId: frame.routeId });
    return;
  }
  const client = room.findByRoute(want);
  const att = client ? room.att(client) : null;
  if (!client || !att || att.kind !== "resumehello") {
    sendErr(ws, "unbound", "route is not ResumeHello", { routeId: frame.routeId });
    return;
  }
  const { est } = room.countKinds();
  if (est >= MAX_ESTABLISHED) {
    room.closeBind(client, "too_many_devices", "established cap 10");
    return;
  }
  att.kind = "established";
  room.writeAtt(client, att);
  room.store.upsertBind({ route_id: att.route_id, kind: "established", created_at: att.created_ms, pair_ref: "" });
  room.noteBind("established");
  await clearKindRef(room.store, "resume_15s", att.route_id);
  client.send(encode(frame));
}

export function handleFakeEstablished(ws: RoomSocket): void {
  sendErr(ws, "unbound", "clients must not send SESSION_ESTABLISHED");
}

export function handleDaemonError(room: RoomCore, ws: RoomSocket, frame: Frame): void {
  const req = parseJSONObject(frame.payload);
  const code = typeof req?.code === "string" ? req.code : "";
  if (!req || !code) {
    sendErr(ws, "bad_token", "invalid ERROR payload");
    return;
  }
  if (room.daemon !== ws) return;
  const bodyRid = typeof req.route_id === "string" ? req.route_id : "";
  if (bodyRid) {
    const want = routeHex(frame.routeId);
    if (bodyRid !== want) {
      sendErr(ws, "bad_token", "ERROR route mismatch");
      return;
    }
    const client = room.findByRoute(want);
    if (!client) return;
    client.send(encode(frame));
    const att = room.att(client);
    if (att?.route_id) room.deleteBind(att.route_id);
    try {
      client.close(1000, code);
    } catch {
      /* already closed */
    }
    return;
  }
  if (!isZeroRoute(frame.routeId)) {
    sendErr(ws, "bad_token", "ERROR missing route_id payload");
    return;
  }
  for (const c of room.sockets()) {
    const a = room.att(c);
    if (a?.role === "phone") c.send(encode(frame));
  }
}
