import { describe, expect, test } from "bun:test";
import { HELLO_GRACE_MS, MAX_PENDING_HELLO } from "../constants.ts";
import { sha256Hex, ZERO_ROUTE } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { encodeJSON } from "../frames.ts";
import { FakeRoomNamespace } from "../testutil/fake-ns.ts";
import { makeRoom } from "../testutil/make-room.ts";
import { onMessage } from "./ws.ts";

function upgrade(rooms: FakeRoomNamespace, daemonId: string, role: "client" | "daemon"): Promise<Response> {
  const request = new Request(`https://pairfob.com/v2/ws?role=${role}&daemon_id=${daemonId}`, {
    headers: { Upgrade: "websocket" },
  });
  return rooms.get(rooms.idFromName(daemonId)).fetch(request);
}

describe("pending websocket lifecycle", () => {
  test("silent phone and daemon upgrades are closed after the hello deadline", async () => {
    const daemonId = "d_" + "ab".repeat(10);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);
    expect((await upgrade(rooms, daemonId, "daemon")).status).toBe(101);
    const h = rooms.harness(daemonId)!;

    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();

    expect(h.sockets.every((socket) => socket.closed)).toBe(true);
  });

  test("pending upgrade cap fails closed without accepting another socket", async () => {
    const daemonId = "d_" + "cd".repeat(10);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    for (let i = 0; i < MAX_PENDING_HELLO; i++) {
      expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);
    }

    const rejected = await upgrade(rooms, daemonId, "client");
    expect(rejected.status).toBe(429);
    expect(rooms.harness(daemonId)!.sockets.length).toBe(MAX_PENDING_HELLO);
  });

  test("a registered daemon is not reaped by its upgrade deadline", async () => {
    const daemonId = "d_" + "ef".repeat(10);
    const token = "rt_" + "12".repeat(16);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    await upgrade(rooms, daemonId, "daemon");
    const h = rooms.harness(daemonId)!;
    h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "12".repeat(8) });
    await onMessage(
      h.core,
      h.sockets[0],
      encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
        v: 2,
        op: "RegisterDaemon",
        daemon_id: daemonId,
        reconnect_token: token,
      }),
    );

    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();
    expect(h.sockets[0].closed).toBe(false);
  });

  test("a registered daemon survives fresh runtime socket wrappers", async () => {
    const daemonId = "d_" + "fa".repeat(10);
    const token = "rt_" + "34".repeat(16);
    const rooms = new FakeRoomNamespace((name) =>
      makeRoom(name, undefined, { freshSocketViews: true }),
    );
    await upgrade(rooms, daemonId, "daemon");
    const h = rooms.harness(daemonId)!;
    h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "34".repeat(8) });
    await onMessage(
      h.core,
      h.sockets[0],
      encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
        v: 2,
        op: "RegisterDaemon",
        daemon_id: daemonId,
        reconnect_token: token,
      }),
    );

    expect(h.core.countPendingHellos()).toBe(0);
    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();
    expect(h.sockets[0].closed).toBe(false);
  });
});
