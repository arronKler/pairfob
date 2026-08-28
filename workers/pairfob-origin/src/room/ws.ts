import { Typ } from "../envelope.ts";
import { decodeFwdMessage, decodeMessage, reject } from "../frames.ts";
import type { RoomCore } from "./core.ts";
import { handleDaemonHello } from "./daemon-hello.ts";
import { fwdWireFromClient, fwdWireFromDaemon } from "./fwd.ts";
import { handlePairAttach, handlePairClose, handlePairOpen } from "./pairing.ts";
import { handlePing, handlePong } from "./ping.ts";
import {
  handleClientHello,
  handleDaemonError,
  handleFakeEstablished,
  handleSessionAttach,
  handleSessionEstablished,
} from "./session.ts";
import type { RoomSocket } from "./types.ts";

export function onMessage(
  room: RoomCore,
  ws: RoomSocket,
  message: string | ArrayBuffer | Uint8Array,
): void | Promise<void> {
  const fwdWire = decodeFwdMessage(message);
  if (fwdWire !== undefined) {
    if (fwdWire === null) {
      reject(ws, "bad_frame", "invalid envelope");
      return;
    }
    return onFwdWire(room, ws, fwdWire);
  }

  const decoded = decodeMessage(message);
  if (!decoded) {
    reject(ws, "bad_frame", "invalid envelope");
    return;
  }
  const { frame, wire } = decoded;
  if (frame.typ === Typ.PING) {
    handlePing(room, ws, frame);
    return;
  }
  if (frame.typ === Typ.PONG) {
    handlePong(ws, frame);
    return;
  }

  const att = room.att(ws);
  const role = att?.role ?? "phone";

  if (role === "daemon") {
    if (room.daemon !== ws && frame.typ !== Typ.HELLO_DAEMON) {
      reject(ws, "unbound", "HELLO_DAEMON must be the first frame");
      return;
    }
    switch (frame.typ) {
      case Typ.HELLO_DAEMON:
        return handleDaemonHello(room, ws, frame);
      case Typ.PAIR_OPEN:
        return handlePairOpen(room, ws, frame);
      case Typ.PAIR_CLOSE:
        return handlePairClose(room, ws, frame);
      case Typ.FWD:
        return onFwdWire(room, ws, wire);
      case Typ.ERROR:
        handleDaemonError(room, ws, frame);
        return;
      case Typ.SESSION_ESTABLISHED:
        return handleSessionEstablished(room, ws, frame);
      default:
        reject(ws, "unbound", "frame type is not valid on daemon websocket");
    }
    return;
  }

  if ((!att || !att.hello_at_ms) && frame.typ !== Typ.HELLO_CLIENT) {
    reject(ws, "unbound", "HELLO_CLIENT must be the first frame");
    return;
  }
  switch (frame.typ) {
    case Typ.HELLO_CLIENT:
      return handleClientHello(room, ws, frame);
    case Typ.PAIR_ATTACH:
      return handlePairAttach(room, ws, frame);
    case Typ.SESSION_ATTACH:
      return handleSessionAttach(room, ws, frame);
    case Typ.FWD:
      return onFwdWire(room, ws, wire);
    case Typ.SESSION_ESTABLISHED:
      handleFakeEstablished(ws);
      return;
    default:
      reject(ws, "unbound", "frame type is not valid on client websocket");
  }
}

function onFwdWire(room: RoomCore, ws: RoomSocket, wire: Uint8Array): void | Promise<void> {
  const att = room.att(ws);
  const role = att?.role ?? "phone";
  if (role === "daemon") {
    if (room.daemon !== ws) {
      reject(ws, "unbound", "HELLO_DAEMON must be the first frame");
      return;
    }
    fwdWireFromDaemon(room, ws, wire);
    return;
  }
  if (!att || !att.hello_at_ms) {
    reject(ws, "unbound", "HELLO_CLIENT must be the first frame");
    return;
  }
  return fwdWireFromClient(room, ws, att, wire);
}
