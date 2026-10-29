import { describe, expect, test } from "bun:test";
import { HELLO_GRACE_MS, MAX_PENDING_HELLO, RESUME_MS } from "../constants.ts";
import { sha256Hex, ZERO_ROUTE } from "../crypto.ts";
import { Typ } from "../envelope.ts";
import { encodeJSON } from "../frames.ts";
import { FakeRoomNamespace } from "../testutil/fake-ns.ts";
import { enrollDaemon, makeRoom } from "../testutil/make-room.ts";
import { onMessage } from "./ws.ts";

function upgrade(rooms: FakeRoomNamespace, daemonId: string, role: "client" | "daemon"): Promise<Response> {
  const request = new Request(`https://pairfob.com/v2/ws?role=${role}&daemon_id=${daemonId}`, {
    headers: { Upgrade: "websocket" },
  });
  return rooms.get(rooms.idFromName(daemonId)).fetch(request);
}

describe("pending websocket lifecycle", () => {
  test("pending sockets share one hello alarm", async () => {
    const daemonId = "d_" + "12".repeat(10);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);
    expect((await upgrade(rooms, daemonId, "daemon")).status).toBe(101);
    const h = rooms.harness(daemonId)!;

    expect(h.store.listAlarms()).toHaveLength(1);
    expect(h.store.listAlarms()[0].kind).toBe("hello_5s");

    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();
    expect(h.sockets.every((socket) => socket.closed)).toBe(true);
    expect(h.store.listAlarms()).toEqual([]);
    expect(await h.store.getAlarm()).toBeNull();
  });

  test("a later pending socket re-arms the shared hello alarm", async () => {
    const daemonId = "d_" + "34".repeat(10);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);
    const h = rooms.harness(daemonId)!;
    h.tick(HELLO_GRACE_MS - 1_000);
    const secondAt = h.clock.t;
    expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);

    h.tick(1_000);
    await h.core.alarm();
    expect(h.sockets[0].closed).toBe(true);
    expect(h.sockets[1].closed).toBe(false);
    const rearmed = secondAt + HELLO_GRACE_MS;
    expect(h.store.listAlarms()).toHaveLength(1);
    expect(h.store.listAlarms()[0].at).toBe(rearmed);
    expect(await h.store.getAlarm()).toBe(rearmed);

    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();
    expect(h.sockets[1].closed).toBe(true);
    expect(h.store.listAlarms()).toEqual([]);
    expect(await h.store.getAlarm()).toBeNull();
  });

  test("a phone hello extends the shared deadline", async () => {
    const daemonId = "d_" + "56".repeat(10);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);
    const h = rooms.harness(daemonId)!;
    h.tick(4_000);
    const helloAt = h.clock.t;
    await onMessage(h.core, h.sockets[0], encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
    expect(h.store.listAlarms()[0].at).toBe(helloAt + HELLO_GRACE_MS);
    expect(await h.store.getAlarm()).toBe(helloAt + HELLO_GRACE_MS);

    h.tick(HELLO_GRACE_MS - 1_000);
    await h.core.alarm();
    expect(h.sockets[0].closed).toBe(false);

    h.tick(1_000);
    await h.core.alarm();
    expect(h.sockets[0].closed).toBe(true);
    expect(h.store.listAlarms()).toEqual([]);
  });

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

    expect(h.store.listAlarms()).toEqual([]);
    expect(await h.store.getAlarm()).toBeNull();
    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();
    expect(h.sockets[0].closed).toBe(false);
  });

  test("a registration keeps another socket's hello deadline", async () => {
    const daemonId = "d_" + "9a".repeat(10);
    const h = makeRoom(daemonId);
    const rooms = new FakeRoomNamespace(() => h);
    const daemon = await enrollDaemon(h);
    expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);
    const phone = h.sockets[1];
    const deadline = h.clock.t + HELLO_GRACE_MS;

    h.tick(1_000);
    await onMessage(h.core, daemon.ws, encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: daemonId,
      reconnect_token: daemon.token,
    }));

    expect(h.store.listAlarms()).toHaveLength(1);
    expect(h.store.listAlarms()[0].at).toBe(deadline);
    expect(await h.store.getAlarm()).toBe(deadline);

    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();
    expect(phone.closed).toBe(true);
  });

  test("a session attach clears the hello alarm and keeps the resume deadline", async () => {
    const daemonId = "d_" + "9c".repeat(10);
    const h = makeRoom(daemonId);
    const rooms = new FakeRoomNamespace(() => h);
    const daemon = await enrollDaemon(h);
    await onMessage(h.core, daemon.ws, encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2,
      op: "RegisterDaemon",
      daemon_id: daemonId,
      reconnect_token: daemon.token,
    }));
    expect((await upgrade(rooms, daemonId, "client")).status).toBe(101);
    const phone = h.sockets[1];
    await onMessage(h.core, phone, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));

    const attachedAt = h.clock.t;
    await onMessage(h.core, phone, encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: daemonId }));

    expect(h.store.listAlarms()).toHaveLength(1);
    expect(h.store.listAlarms()[0].kind).toBe("resume_15s");
    expect(await h.store.getAlarm()).toBe(attachedAt + RESUME_MS);
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
