import { HELLO_GRACE_MS, RESUME_MS } from "../constants.ts";
import { hexToBytes } from "../crypto.ts";
import { Typ, type Frame } from "../envelope.ts";
import { encodeRaw, reject, sendErr } from "../frames.ts";
import type { RoomCore } from "./core.ts";
import type { RoomSocket } from "./types.ts";

/** Envelope PING/PONG: no SQL, no platform alarm writes, no ResumeHello renewal. */
export function handlePing(room: RoomCore, ws: RoomSocket, frame: Frame): void {
  const att = room.att(ws);
  const now = room.now();
  if (att) {
    if (att.role === "phone" && att.mode === "hello" && att.kind === "none" && att.hello_at_ms && now - att.hello_at_ms > HELLO_GRACE_MS) {
      sendErr(ws, "unbound", "5s attach timeout");
      ws.close(1000, "unbound");
      return;
    }
    if (att.kind === "resumehello" && now - att.created_ms > RESUME_MS) {
      const rid = att.route_id ? hexToBytes(att.route_id) : undefined;
      sendErr(ws, "unpaired", "15s DeviceHello timeout", rid ? { routeId: rid } : undefined);
      ws.close(1000, "unpaired");
      return;
    }
  }
  if (frame.payload.length !== 8) {
    reject(ws, "unbound", "PING payload must be exactly 8 bytes");
    return;
  }
  ws.send(encodeRaw(Typ.PONG, frame.routeId, frame.payload));
}

export function handlePong(ws: RoomSocket, frame: Frame): void {
  if (frame.payload.length !== 8) {
    reject(ws, "unbound", "PONG payload must be exactly 8 bytes");
  }
}
