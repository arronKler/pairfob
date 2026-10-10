import { describe, expect, test } from "bun:test";
import { newAttachment, type Attachment } from "./attachment.ts";
import { lifecycleLog, socketCounts, socketFields, traceLifecycle } from "./lifecycle-diagnostics.ts";

const env = { BUILD: "lifecycle-test", ROOM_DIAGNOSTICS_SAMPLE_RATE: "0.01", ROOM_DIAGNOSTICS_UNTIL: "2099-01-01T00:00:00Z" };
const id = "ab".repeat(32);

function socket(att: Attachment, readyState = 1): WebSocket {
  return { deserializeAttachment: () => att, readyState } as WebSocket;
}

async function capture(work: (logs: Record<string, unknown>[]) => void | Promise<void>) {
  const logs: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = (line: unknown) => { logs.push(JSON.parse(String(line))); };
  try { await work(logs); } finally { console.log = original; }
}

describe("room lifecycle diagnostics", () => {
  test("distinguishes retired registered sockets from a new pending hello without exposing route metadata", () => {
    const old = newAttachment("daemon", 1000, { retired: true, hello_at_ms: 1001, route_id: "secret-route", pair_ref: "secret-pair" });
    const active = newAttachment("daemon", 2000, { hello_at_ms: 2001 });
    const pending = newAttachment("daemon", 3000);
    expect(socketCounts([socket(old, 2), socket(active), socket(pending)])).toEqual({
      runtime_sockets: 3, registered_daemons: 1, pending_hellos: 1, retired_sockets: 1, closing_sockets: 1,
    });
    expect(socketFields(old, 2)).toMatchObject({ registered: true, retired: true, socket_state: 2, created_ms: 1000 });
    expect(JSON.stringify(socketFields(old, 2))).not.toContain("secret");
  });

  test("captures both sides of registration and preserves synchronous dispatch", async () => {
    await capture((logs) => {
      let retired = false;
      expect(traceLifecycle(env, id, "room_daemon_hello", () => ({ retired }), () => { retired = true; })).toBeUndefined();
      expect(logs.map(x => [x.phase, x.retired])).toEqual([["start", false], ["end", true]]);
      expect(logs[0].started_ms).toBe(logs[1].started_ms);
    });
  });

  test("metadata read and logger failures cannot skip work or mask its failure", async () => {
    await capture(async (logs) => {
      let called = 0;
      traceLifecycle(env, id, "room_alarm", () => { throw new Error("metadata"); }, () => { called++; });
      expect(called).toBe(1);
      expect(logs).toEqual([]);
      const failure = new Error("private failure");
      await expect(traceLifecycle(env, id, "room_alarm", () => ({}), () => Promise.reject(failure))).rejects.toBe(failure);
      expect(logs.map(x => x.phase)).toEqual(["start", "error"]);
      expect(JSON.stringify(logs)).not.toContain(failure.message);
    });
  });

  test("expired diagnostics neither inspect sockets nor wrap promises", async () => {
    await capture((logs) => {
      const expired = { ...env, ROOM_DIAGNOSTICS_UNTIL: "2020-01-01T00:00:00Z" };
      const fields = () => { throw new Error("must not inspect"); };
      const pending = Promise.resolve();
      expect(traceLifecycle(expired, id, "room_alarm", fields, () => pending)).toBe(pending);
      lifecycleLog(expired, id, "room_upgrade_accepted", fields);
      expect(logs).toEqual([]);
    });
  });
});
