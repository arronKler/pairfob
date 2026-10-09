import { describe, expect, test } from "bun:test";
import { HELLO_GRACE_MS } from "../constants.ts";
import { FakeRoomNamespace } from "../testutil/fake-ns.ts";
import { makeRoom, PAIR_REF } from "../testutil/make-room.ts";

function setup(role: "client" | "daemon", ticket?: string) {
  const h = makeRoom();
  const rooms = new FakeRoomNamespace(() => h);
  const controller = new AbortController();
  const url = new URL("https://pairfob.com/v2/ws");
  url.search = new URLSearchParams({ role, daemon_id: h.core.daemonId }).toString();
  if (ticket) url.searchParams.set("pair_ticket", ticket);
  const request = new Request(url, {
    headers: { Upgrade: "websocket" },
    signal: controller.signal,
  });
  return { h, controller, fetch: () => rooms.get(rooms.idFromName(h.core.daemonId)).fetch(request) };
}

function pauseAlarm(h: ReturnType<typeof makeRoom>) {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  const original = h.store.setAlarmIfChanged.bind(h.store);
  h.store.setAlarmIfChanged = async (next) => {
    await original(next);
    h.store.setAlarmIfChanged = original;
    entered();
    await resumed;
  };
  return { waiting, release };
}

describe("canceled websocket upgrades", () => {
  for (const role of ["client", "daemon"] as const) {
    test(`${role}: already canceled requests never schedule or accept a socket`, async () => {
      const { h, controller, fetch } = setup(role);
      controller.abort();

      await expect(fetch()).rejects.toHaveProperty("name", "AbortError");
      expect(h.sockets).toHaveLength(0);
      expect(h.store.listAlarms()).toEqual([]);
      expect(h.store.stats.setAlarm).toBe(0);
    });

    test(`${role}: cancellation during alarm persistence never accepts an orphan`, async () => {
      const { h, controller, fetch } = setup(role);
      const alarm = pauseAlarm(h);
      const pending = fetch();
      await alarm.waiting;
      expect(h.sockets).toHaveLength(0);
      controller.abort();
      alarm.release();

      await expect(pending).rejects.toHaveProperty("name", "AbortError");
      expect(h.sockets).toHaveLength(0);
      h.tick(HELLO_GRACE_MS);
      await h.core.alarm();
      expect(h.store.listAlarms()).toEqual([]);
      expect(await h.store.getAlarm()).toBeNull();

      // The canceled attempt must not prevent the next connection from upgrading.
      const rooms = new FakeRoomNamespace(() => h);
      const response = await rooms.get(rooms.idFromName(h.core.daemonId)).fetch(
        new Request(`https://pairfob.com/v2/ws?role=${role}&daemon_id=${h.core.daemonId}`),
      );
      expect(response.status).toBe(101);
      expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("pairfob.v2");
      expect(h.sockets).toHaveLength(1);
    });
  }

  test("a pending alarm write still permits an uncanceled upgrade", async () => {
    const { h, fetch } = setup("client");
    const alarm = pauseAlarm(h);
    const pending = fetch();
    await alarm.waiting;
    expect(h.sockets).toHaveLength(0);
    alarm.release();

    expect((await pending).status).toBe(101);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].closed).toBe(false);
    h.tick(HELLO_GRACE_MS);
    await h.core.alarm();
    expect(h.sockets[0].closed).toBe(true);
  });

  for (const when of ["before", "during"] as const) {
    test(`ticket consumption stays one-shot when canceled ${when} upgrade preparation`, async () => {
      const ticket = "12".repeat(16);
      const { h, controller, fetch } = setup("client", ticket);
      h.store.insertTicket({ ticket, pair_ref: PAIR_REF, deadline: h.clock.t + 15000 });
      const alarm = when === "during" ? pauseAlarm(h) : null;
      if (!alarm) controller.abort();
      const pending = fetch();
      if (alarm) {
        await alarm.waiting;
        controller.abort();
        alarm.release();
      }
      await expect(pending).rejects.toHaveProperty("name", "AbortError");
      expect(h.sockets).toHaveLength(0);
      expect(h.core.consumeUpgrade(new URLSearchParams({ pair_ticket: ticket }), "client").ok).toBe(when === "before");
      expect(h.core.consumeUpgrade(new URLSearchParams({ pair_ticket: ticket }), "client").ok).toBe(false);
    });
  }
});
