import { describe, expect, test } from "bun:test";
import { closeReason, diagnosticsEnabled, frameLabel, traceHandler } from "./diagnostics.ts";
import { encodeRaw } from "../frames.ts";
import { Typ } from "../envelope.ts";
import { DaemonRoom } from "./room.ts";

const env = { BUILD: "diagnostic-test", ROOM_DIAGNOSTICS_SAMPLE_RATE: "1", ROOM_DIAGNOSTICS_UNTIL: "2099-01-01T00:00:00Z" };
const objectId = "ab".repeat(32);

async function capture(work: (logs: string[]) => void | Promise<void>) {
  const logs: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => { logs.push(String(line)); };
  try { await work(logs); } finally { console.log = original; }
}

describe("room diagnostics", () => {
  test("sampling is opt-in, bounded and expires", () => {
    const now = Date.parse("2026-10-08T00:00:00Z");
    expect(diagnosticsEnabled({}, now, () => 0)).toBe(false);
    expect(diagnosticsEnabled(env, now, () => 0.99)).toBe(true);
    for (const rate of ["NaN", "Infinity", "-1", "0", "1.1"]) {
      expect(diagnosticsEnabled({ ...env, ROOM_DIAGNOSTICS_SAMPLE_RATE: rate }, now, () => 0)).toBe(false);
    }
    expect(diagnosticsEnabled({ ...env, ROOM_DIAGNOSTICS_UNTIL: "invalid" }, now)).toBe(false);
    expect(diagnosticsEnabled({ ...env, ROOM_DIAGNOSTICS_UNTIL: new Date(now).toISOString() }, now)).toBe(false);
    expect(diagnosticsEnabled({ ...env, ROOM_DIAGNOSTICS_SAMPLE_RATE: "0.01" }, now, () => 0.02)).toBe(false);
  });

  test("sync dispatch stays sync and logs only bounded header metadata", async () => {
    const secret = "rt_secret payload never logged";
    const wire = encodeRaw(Typ.FWD, new Uint8Array(16), new TextEncoder().encode(secret));
    await capture((logs) => {
      const result = traceHandler(env, objectId, frameLabel(wire.buffer as ArrayBuffer), "daemon", () => {});
      expect(result).toBeUndefined();
      const events = logs.map((line) => JSON.parse(line));
      expect(events.map((event) => event.phase)).toEqual(["start", "end"]);
      expect(events[0].frame).toBe("FWD");
      expect(events[0].event_id).toBe(events[1].event_id);
      expect(events[1].object_id).toBe(objectId);
      expect(logs.join()).not.toContain(secret);
    });
    expect(frameLabel(secret)).toBe("text");
    expect(frameLabel(new ArrayBuffer(1))).toBe("short");
  });

  test("async end waits for settlement and errors retain identity without logging their text", async () => {
    await capture(async (logs) => {
      let complete!: () => void;
      const pending = traceHandler(env, objectId, "HELLO_DAEMON", "daemon", () => new Promise<void>((resolve) => { complete = resolve; }));
      expect(logs.length).toBe(1);
      complete();
      await pending;
      expect(JSON.parse(logs[1]).phase).toBe("end");
      const failure = new Error("rt_secret");
      try { await traceHandler(env, objectId, "PING", "daemon", () => Promise.reject(failure)); }
      catch (error) { expect(error).toBe(failure); }
      expect(JSON.parse(logs.at(-1)!).phase).toBe("error");
      expect(logs.join()).not.toContain("rt_secret");
      expect(() => traceHandler(env, objectId, "PING", "daemon", () => { throw failure; })).toThrow(failure);
    });
  });

  test("disabled tracing preserves return value and logging failure cannot break dispatch", async () => {
    await capture((logs) => {
      const pending = Promise.resolve();
      expect(traceHandler({}, objectId, "PING", "daemon", () => pending)).toBe(pending);
      expect(logs).toEqual([]);
    });
    const original = console.log;
    console.log = () => { throw new Error("logger unavailable"); };
    try { expect(traceHandler(env, objectId, "PING", "daemon", () => {})).toBeUndefined(); }
    finally { console.log = original; }
  });

  test("close metadata keeps code and cleanliness but excludes arbitrary peer reasons", async () => {
    const closed: string[] = [];
    const room = {
      env, ctx: { id: { toString: () => objectId } }, wraps: new WeakMap(),
      core: { att: () => ({ role: "phone" }), onClose: (_ws: unknown, reason: string) => closed.push(reason) },
    } as unknown as DaemonRoom;
    await capture((logs) => {
      DaemonRoom.prototype.webSocketClose.call(room, { close() {} } as WebSocket, 1006, "reconnect_token=rt_secret", false);
      DaemonRoom.prototype.webSocketError.call(room, {} as WebSocket, new Error("rt_secret"));
      const event = JSON.parse(logs[0]);
      expect(event).toMatchObject({ code: 1006, was_clean: false, reason: "other", role: "phone" });
      expect(logs.join()).not.toContain("rt_secret");
      expect(closed).toEqual(["other"]); // error callback must not tear down usable peers.
    });
    expect(closeReason("replaced")).toBe("replaced");
    expect(closeReason("")).toBe("empty");
  });
});
