import { describe, expect, test } from "bun:test";
import { sha256Hex, ZERO_ROUTE } from "../crypto.ts";
import { decode, Typ } from "../envelope.ts";
import { encodeJSON, encodeRaw } from "../frames.ts";
import { newAttachment, type Attachment } from "./attachment.ts";
import { CfSocket, wrapSockets, type HibernatingSocket } from "./cf-socket.ts";
import { RoomCore } from "./core.ts";
import { MemoryStore } from "./memory-store.ts";
import { DaemonRoom } from "./room.ts";
import { onMessage } from "./ws.ts";

/** Models a half-closed socket whose runtime readyState resets on a later wake. */
class RevivedSocket implements HibernatingSocket {
  readyState = WebSocket.OPEN;
  closes = 0;
  sent: Uint8Array[] = [];
  constructor(public attachment: Attachment) {}
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void { this.closes++; this.readyState = WebSocket.CLOSING; }
  serializeAttachment(att: Attachment): void { this.attachment = { ...att }; }
  deserializeAttachment(): Attachment { return { ...this.attachment }; }
}

describe("socket retirement across hibernation", () => {
  test("restored OPEN state cannot reclose or send on a retired socket", () => {
    const raw = new RevivedSocket(newAttachment("daemon", 100, { hello_at_ms: 100 }));
    new CfSocket(raw).close(1000, "replaced");
    for (let wake = 0; wake < 3; wake++) {
      raw.readyState = WebSocket.OPEN;
      const restored = new CfSocket(raw);
      expect(restored.isRetired()).toBe(true);
      restored.close(1000, "replaced");
      expect(() => restored.send(new Uint8Array([1]))).toThrow(TypeError);
      expect(wrapSockets([raw as unknown as WebSocket], new WeakMap())).toEqual([]);
    }
    expect(raw.closes).toBe(1);
    expect(raw.sent).toEqual([]);
  });

  test("cleanup using an older attachment cannot undo retirement", () => {
    const raw = new RevivedSocket(newAttachment("phone", 100, { kind: "established", route_id: "ab".repeat(16) }));
    const ws = new CfSocket(raw);
    const beforeClose = ws.deserializeAttachment()!;
    ws.close(1000, "unpaired");
    ws.serializeAttachment({ ...beforeClose, kind: "none", route_id: "" });
    expect(raw.attachment).toMatchObject({ retired: true, kind: "none", route_id: "" });
    expect(new CfSocket(raw).isRetired()).toBe(true);
  });

  test("attachment persistence failures remain visible and precede transport close", () => {
    const raw = new RevivedSocket(newAttachment("daemon", 100));
    const error = new Error("storage unavailable");
    raw.serializeAttachment = () => { throw error; };
    expect(() => new CfSocket(raw).close(1000, "replaced")).toThrow(error);
    expect(raw.closes).toBe(0);
    expect(raw.attachment.retired).toBeUndefined();
  });

  test("unexpected send failures on live sockets retain their identity", () => {
    const raw = new RevivedSocket(newAttachment("daemon", 100));
    const error = new Error("instance no longer active");
    raw.send = () => { throw error; };
    expect(() => new CfSocket(raw).send(new Uint8Array([1]))).toThrow(error);
  });

  test.each(["attachment", "transport"])("replacement does not ACK success after an old daemon %s failure", async (kind) => {
    const old = new RevivedSocket(newAttachment("daemon", 100, { hello_at_ms: 100 }));
    const next = new RevivedSocket(newAttachment("daemon", 200));
    const raw = [old, next] as unknown as WebSocket[];
    const wraps = new WeakMap<WebSocket, CfSocket>();
    const core = new RoomCore({
      daemonId: "d_" + "ab".repeat(10), store: new MemoryStore(), now: () => 300,
      randomBytes: (n) => new Uint8Array(n), sockets: () => wrapSockets(raw, wraps),
    });
    const token = "rt_" + "ab".repeat(16);
    core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "ab".repeat(8) });
    core.coldStart();
    const error = new Error("injected " + kind + " failure");
    if (kind === "attachment") old.serializeAttachment = () => { throw error; };
    else old.close = () => { throw error; };
    const register = encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
      v: 2, op: "RegisterDaemon", daemon_id: core.daemonId, reconnect_token: token,
    });
    await expect(onMessage(core, wraps.get(raw[1])!, register)).rejects.toBe(error);
    expect(core.daemon).toBe(wraps.get(raw[0])!);
    expect(next.sent).toEqual([]);
    expect(next.attachment.hello_at_ms).toBe(0);
    expect(old.attachment.retired).toBe(kind === "attachment" ? undefined : true);
  });

  test("cold starts and delayed old-daemon events preserve the successor", () => {
    const old = new RevivedSocket(newAttachment("daemon", 100, { hello_at_ms: 100 }));
    const live = new RevivedSocket(newAttachment("daemon", 200, { hello_at_ms: 200 }));
    const raw = [old, live] as unknown as WebSocket[];
    const store = new MemoryStore();
    for (let wake = 0; wake < 3; wake++) {
      old.readyState = WebSocket.OPEN;
      const wraps = new WeakMap<WebSocket, CfSocket>();
      const core = new RoomCore({
        daemonId: "d_" + "ab".repeat(10), store, now: () => 300,
        randomBytes: (n) => new Uint8Array(n), sockets: () => wrapSockets(raw, wraps),
      });
      core.coldStart();
      const successor = wraps.get(raw[1])!;
      expect(core.daemon).toBe(successor);
      expect(core.sockets()).toEqual([successor]);
      const room = { wraps, core, env: {}, ctx: { id: { toString: () => "test" } } } as unknown as DaemonRoom;
      const dispatch = (ws: WebSocket, wire: Uint8Array) => DaemonRoom.prototype.webSocketMessage.call(room, ws, wire.buffer as ArrayBuffer);
      dispatch(raw[0], encodeRaw(Typ.PING, ZERO_ROUTE, new Uint8Array(8)));
      dispatch(raw[0], encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, { v: 2, op: "RegisterDaemon" }));
      core.onClose(wraps.get(raw[0])!, "replaced");
      expect(core.daemon).toBe(successor);
      dispatch(raw[1], encodeRaw(Typ.PING, ZERO_ROUTE, new Uint8Array(8)));
      expect(decode(live.sent.at(-1)!).typ).toBe(Typ.PONG);
      expect(old.sent).toEqual([]);
      expect(old.closes).toBe(1);
      expect(live.closes).toBe(0);
    }
  });
});
