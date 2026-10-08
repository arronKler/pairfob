import { describe, expect, test } from "bun:test";
import { makeRoom } from "../testutil/make-room.ts";
import { newAttachment } from "./attachment.ts";
import type { FakeSocket } from "./fake-socket.ts";

const route = "11".repeat(16);
const closedSend = () => new TypeError("Can't call WebSocket send() after close().");

function failSend(ws: FakeSocket, error: unknown): void {
  ws.send = () => { throw error; };
}

function setup(kind: "established" | "pairing" = "established") {
  const h = makeRoom();
  const daemon = h.accept("daemon").ws!;
  daemon.serializeAttachment(newAttachment("daemon", h.clock.t, { hello_at_ms: h.clock.t }));
  const phone = h.accept("phone").ws!;
  phone.serializeAttachment(newAttachment("phone", h.clock.t, {
    hello_at_ms: h.clock.t, mode: kind === "pairing" ? "pairing" : "session",
    kind, route_id: route, pair_ref: "pair",
  }));
  h.core.rebuildMaps();
  h.store.upsertBind({ route_id: route, kind, created_at: h.clock.t, pair_ref: "pair" });
  return { h, daemon, phone };
}

describe("teardown notification failures", () => {
  test("phone close releases its binding when the daemon rejects send-after-close", () => {
    const { h, daemon, phone } = setup();
    failSend(daemon, closedSend());
    phone.close();
    h.core.onClose(phone);
    expect(h.store.listBinds()).toEqual([]);
    expect(h.core.findByRoute(route)).toBeNull();
    expect(h.core.att(phone)?.route_id).toBe("");
    daemon.send = () => { throw new Error("duplicate notification"); };
    expect(() => h.core.onClose(phone)).not.toThrow();
  });

  test("unknown send errors escape only after phone cleanup", () => {
    const { h, daemon, phone } = setup();
    const error = new Error("instance no longer active");
    failSend(daemon, error);
    phone.close();
    expect(() => h.core.onClose(phone)).toThrow(error);
    expect(h.store.listBinds()).toEqual([]);
    expect(h.core.findByRoute(route)).toBeNull();
  });

  test("daemon close cleans every phone before propagating an unknown notification failure", () => {
    const { h, daemon, phone } = setup();
    const other = h.accept("phone").ws!;
    const error = new Error("transport failed");
    failSend(phone, error);
    daemon.close();
    expect(() => h.core.onClose(daemon)).toThrow(error);
    expect(h.core.daemon).toBeNull();
    expect(phone.closed).toBe(true);
    expect(other.closed).toBe(true);
    expect(h.store.listBinds()).toEqual([]);
    expect(h.core.att(phone)?.route_id).toBe("");
  });

  test("a delayed or duplicate old-daemon close preserves the successor and its phone", () => {
    const { h, daemon, phone } = setup();
    const replacement = h.accept("daemon").ws!;
    replacement.serializeAttachment(newAttachment("daemon", h.clock.t, { hello_at_ms: h.clock.t + 1 }));
    h.core.rebuildMaps();
    h.core.onClose(daemon);
    h.core.onClose(daemon);
    expect(h.core.daemon).toBe(replacement);
    expect(phone.closed).toBe(false);
    expect(h.core.findByRoute(route)).toBe(phone);
  });

  test("kick closes the daemon even when a phone notification fails unexpectedly", () => {
    const { h, daemon, phone } = setup();
    const error = new Error("unexpected notification failure");
    failSend(phone, error);
    expect(() => h.core.kick()).toThrow(error);
    expect(daemon.closed).toBe(true);
    expect(phone.closed).toBe(true);
    expect(h.core.daemon).toBeNull();
    expect(h.store.listBinds()).toEqual([]);
  });

  test("closeBind clears attachment and route even if both notifications fail", () => {
    const { h, daemon, phone } = setup();
    const error = new TypeError("unexpected TypeError");
    failSend(phone, error);
    failSend(daemon, closedSend());
    expect(() => h.core.closeBind(phone, "unpaired", "closed")).toThrow(error);
    expect(phone.closed).toBe(true);
    expect(h.store.listBinds()).toEqual([]);
    expect(h.core.att(phone)?.route_id).toBe("");
    expect(() => h.core.onClose(phone)).not.toThrow();
  });

  test("replacement notifications cannot strand peers or the old pairing slot", () => {
    const { h, phone } = setup();
    const other = h.accept("phone").ws!;
    h.store.putSlot({ pair_ref: "pair", pair_loc: "loc", deadline: h.clock.t + 1000 });
    failSend(phone, closedSend());
    expect(() => h.core.notifyReplaced()).not.toThrow();
    expect(phone.closed).toBe(true);
    expect(other.closed).toBe(true);
    expect(h.store.listBinds()).toEqual([]);
    expect(h.store.loadSlot()).toBeNull();
  });

  test("unknown replacement notification failures propagate after all peer cleanup", () => {
    const { h, phone } = setup();
    const other = h.accept("phone").ws!;
    const error = new Error("unexpected send");
    failSend(phone, error);
    expect(() => h.core.notifyReplaced()).toThrow(error);
    expect(phone.closed).toBe(true);
    expect(other.closed).toBe(true);
    expect(h.core.findByRoute(route)).toBeNull();
  });

  test("a failing close does not block other peers or retain its binding", () => {
    const { h, daemon, phone } = setup();
    const other = h.accept("phone").ws!;
    const error = new Error("runtime close failed");
    phone.close = () => { throw error; };
    daemon.close();
    expect(() => h.core.onClose(daemon)).toThrow(error);
    expect(other.closed).toBe(true);
    expect(h.core.daemon).toBeNull();
    expect(h.store.listBinds()).toEqual([]);
    expect(h.core.att(phone)?.route_id).toBe("");
  });

  test("a timeout close failure still processes other peers and due alarms", async () => {
    const h = makeRoom();
    const first = h.accept("phone").ws!;
    const second = h.accept("phone").ws!;
    const error = new Error("runtime close failed");
    first.close = () => { throw error; };
    h.store.upsertAlarm("hello_5s", "due", h.clock.t + 5000);
    h.tick(6000);
    await expect(h.core.alarm()).rejects.toThrow(error);
    expect(second.closed).toBe(true);
    expect(h.store.listAlarms()).toEqual([]);
  });

  test("storage failures are not converted into successful cleanup", () => {
    const { h, daemon, phone } = setup();
    failSend(daemon, closedSend());
    const error = new Error("storage reset");
    h.store.deleteBind = () => { throw error; };
    phone.close();
    expect(() => h.core.onClose(phone)).toThrow(error);
  });

  test("attachment failures remain visible", () => {
    const { h, daemon, phone } = setup();
    failSend(daemon, closedSend());
    const error = new Error("attachment failed");
    phone.serializeAttachment = () => { throw error; };
    phone.close();
    expect(() => h.core.onClose(phone)).toThrow(error);
  });

  test("hello timeout cleans every socket and advances the alarm before rethrowing unknown send errors", async () => {
    const h = makeRoom();
    const first = h.accept("phone").ws!;
    const second = h.accept("phone").ws!;
    const error = new Error("unexpected send");
    failSend(first, error);
    h.store.upsertAlarm("hello_5s", "due", h.clock.t + 5000);
    h.store.upsertAlarm("ticket_15s", "future", h.clock.t + 15000);
    h.tick(6000);
    await expect(h.core.alarm()).rejects.toThrow(error);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(h.store.listAlarms().map((a) => a.ref)).toEqual(["future"]);
    expect(await h.store.getAlarm()).toBe(h.clock.t + 9000);
  });

  test("expired pairing removes the slot and binding despite notifications to closed sockets", async () => {
    const { h, daemon, phone } = setup("pairing");
    failSend(phone, closedSend());
    failSend(daemon, closedSend());
    h.store.putSlot({ pair_ref: "pair", pair_loc: "loc", deadline: h.clock.t });
    h.store.upsertAlarm("pair_ttl", "pair", h.clock.t);
    await h.core.alarm();
    expect(phone.closed).toBe(true);
    expect(h.store.loadSlot()).toBeNull();
    expect(h.store.listBinds()).toEqual([]);
    expect(h.store.listAlarms()).toEqual([]);
  });

  test("an expired pairing still propagates unexpected daemon send failure", async () => {
    const { h, daemon, phone } = setup("pairing");
    const error = new Error("instance failure");
    failSend(daemon, error);
    h.store.putSlot({ pair_ref: "pair", pair_loc: "loc", deadline: h.clock.t });
    h.store.upsertAlarm("pair_ttl", "pair", h.clock.t);
    await expect(h.core.alarm()).rejects.toThrow(error);
    expect(phone.closed).toBe(true);
    expect(h.store.loadSlot()).toBeNull();
    expect(h.store.listAlarms()).toEqual([]);
  });
});
