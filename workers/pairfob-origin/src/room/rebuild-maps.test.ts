import { describe, expect, test } from "bun:test";
import { sha256Hex, ZERO_ROUTE } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { encodeJSON } from "../frames.ts";
import { makeRoom } from "../testutil/make-room.ts";
import { newAttachment } from "./attachment.ts";
import { FakeSocket } from "./fake-socket.ts";
import { onMessage } from "./ws.ts";

async function registeredDaemon() {
  const room = makeRoom();
  const token = "rt_" + "42".repeat(16);
  room.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "42".repeat(8) });
  const daemon = room.accept("daemon");
  if (!daemon.ok) throw new Error("daemon upgrade failed");
  await onMessage(
    room.core,
    daemon.ws,
    encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: room.core.daemonId,
      reconnect_token: token,
    }),
  );
  return { room, daemon: daemon.ws };
}

describe("rebuildMaps daemon uniqueness", () => {
  test("keeps the newest registered daemon and closes older ghosts", async () => {
    const { room, daemon: live } = await registeredDaemon();
    const ghost = new FakeSocket("ghost");
    ghost.serializeAttachment(newAttachment("daemon", 1, { hello_at_ms: 1 }));
    room.sockets.push(ghost);

    room.core.rebuildMaps();

    expect(room.core.daemon).toBe(live);
    expect(live.closed).toBe(false);
    expect(ghost.closed).toBe(true);
    expect(ghost.closeReason).toBe("replaced");
  });

  test("a later phone attach does not restore a trailing ghost as room.daemon", async () => {
    const { room, daemon: live } = await registeredDaemon();
    const ghost = new FakeSocket("ghost");
    ghost.serializeAttachment(newAttachment("daemon", 1, { hello_at_ms: 1 }));
    room.sockets.push(ghost);

    const phone = room.accept("phone");
    if (!phone.ok) throw new Error("phone upgrade failed");

    expect(room.core.daemon).toBe(live);
    expect(ghost.closed).toBe(true);
    expect(live.closed).toBe(false);
  });
});
