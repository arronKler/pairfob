import { expect, test } from "bun:test";
import { armHello, armResume, schedule } from "./alarms.ts";
import { makeRoom } from "../testutil/make-room.ts";

test("a pending socket that disconnects before hello cancels its platform alarm", async () => {
  const h = makeRoom();
  const socket = h.accept("phone").ws!;
  await armHello(h.core, h.clock.t);
  expect(await h.store.getAlarm()).not.toBeNull();
  // Model getWebSockets() continuing to return the native CLOSING endpoint.
  h.core.onClose(socket);
  await h.core.settleClosedSocket(socket);
  expect(h.store.listAlarms()).toEqual([]);
  expect(await h.store.getAlarm()).toBeNull();
  expect(h.core.att(socket)?.retired).toBe(true);
  // A later cleanup cannot resurrect the closed endpoint's timeout either.
  await h.core.settleClosedSocket(socket);
  expect(await h.store.getAlarm()).toBeNull();
});

test("closing an older hello retains the newer socket's original deadline", async () => {
  const h = makeRoom();
  const first = h.accept("phone").ws!;
  await armHello(h.core, h.clock.t);
  h.tick(1_000);
  h.accept("phone");
  await armHello(h.core, h.clock.t);
  h.core.onClose(first);
  await h.core.settleClosedSocket(first);
  expect(await h.store.getAlarm()).toBe(h.clock.t + 5_000);
});

test("a closed resume releases its timeout without cancelling pairing expiry", async () => {
  const h = makeRoom();
  const socket = h.accept("phone").ws!;
  const route = "ab".repeat(16);
  h.core.writeAtt(socket, { ...h.core.att(socket)!, mode: "session", kind: "resumehello", route_id: route });
  h.store.upsertBind({ route_id: route, kind: "resumehello", created_at: h.clock.t, pair_ref: "" });
  await armResume(h.core, route, h.clock.t);
  await schedule(h.store, "pair_ttl", "pair", h.clock.t + 180_000);
  h.core.onClose(socket);
  await h.core.settleClosedSocket(socket);
  expect(h.store.listBinds()).toEqual([]);
  expect(h.store.listAlarms().map(row => row.kind)).toEqual(["pair_ttl"]);
  expect(await h.store.getAlarm()).toBe(h.clock.t + 180_000);
});
