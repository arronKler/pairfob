import { routeHexAt } from "../crypto.ts";
import { HEADER_SIZE } from "../envelope.ts";
import { sendErr } from "../frames.ts";
import { advancePairFrames } from "./alarms.ts";
import type { Attachment } from "./attachment.ts";
import type { RoomCore } from "./core.ts";
import type { RoomSocket } from "./types.ts";

export function fwdWireFromClient(
  room: RoomCore,
  ws: RoomSocket,
  att: Attachment | null,
  wire: Uint8Array,
): void | Promise<void> {
  if (!att || !att.route_id || (att.kind !== "pairing" && att.kind !== "resumehello" && att.kind !== "established")) {
    sendErr(ws, "unbound", "FWD before bind");
    ws.close(1000, "unbound");
    return;
  }
  const daemon = room.daemon;
  if (!daemon) {
    sendErr(ws, "daemon_offline", "no daemon");
    ws.close(1000, "daemon_offline");
    return;
  }
  const rid = room.routeBytes(att.route_id);
  room.noteFwd(wire.length - HEADER_SIZE);
  if (att.kind === "pairing") {
    att.pair_frames++;
    room.writeAtt(ws, att);
    if (att.pair_frames === 1 || att.pair_frames === 2) {
      const slot = room.store.loadSlot();
      const deadline = slot?.deadline ?? room.now() + 180_000;
      return advanceAndForward(room, ws, daemon, att.route_id, att.pair_frames, deadline, rid, wire);
    }
  }
  forwardWire(daemon, rid, wire);
}

async function advanceAndForward(
  room: RoomCore,
  ws: RoomSocket,
  daemon: RoomSocket,
  routeId: string,
  pairFrames: number,
  deadline: number,
  routeBytes: Uint8Array,
  wire: Uint8Array,
): Promise<void> {
  await advancePairFrames(room, routeId, pairFrames, deadline);
  // Alarm storage may yield. Never deliver an old pairing frame to a replaced
  // daemon or to a bind that was closed while the write was in flight.
  const current = room.att(ws);
  if (room.daemon !== daemon || current?.kind !== "pairing" || current.route_id !== routeId) return;
  forwardWire(daemon, routeBytes, wire);
}

function forwardWire(destination: RoomSocket, routeId: Uint8Array, wire: Uint8Array): void {
  wire.set(routeId, 8);
  destination.send(wire);
}

export function fwdWireFromDaemon(room: RoomCore, ws: RoomSocket, wire: Uint8Array): void {
  if (room.daemon !== ws) return;
  const client = room.findByRoute(routeHexAt(wire, 8));
  if (!client) return;
  room.noteFwd(wire.length - HEADER_SIZE);
  try {
    client.send(wire);
  } catch {
    room.closeBind(client, "unbound", "client send failed");
  }
}
