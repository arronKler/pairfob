import { afterEach, expect, test } from "bun:test";
import { readWorkerNotificationEvidence } from "./notification-diagnostics";

const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "caches", original);
  else Reflect.deleteProperty(globalThis, "caches");
});
function cache(match: () => Promise<Response | undefined>) {
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { match } });
}

test("worker export bounds and sanitizes persisted records instead of exporting cache contents", async () => {
  cache(async () => Response.json([
    { at: Date.now() - 25 * 3600000, event: "notify_sw_click" },
    { at: Date.now(), event: "notify_sw_ack", reason: "captured", url: "private target", body: "private message" },
    { at: Date.now(), event: "notify_sw_client_error", reason: "private exception" },
    { at: Date.now(), event: "unknown event", secret: "private" },
  ]));
  const result = await readWorkerNotificationEvidence();
  expect(result.status).toBe("ok");
  expect(result.records.map(row => [row.event, row.reason])).toEqual([
    ["notify_sw_ack", "captured"], ["notify_sw_client_error", "other"],
  ]);
  expect(JSON.stringify(result)).not.toContain("private");
  cache(async () => Response.json(Array.from({ length: 120 }, () => ({ at: Date.now(), event: "notify_sw_click" }))));
  expect((await readWorkerNotificationEvidence()).records).toHaveLength(100);
});

test("missing or blocked worker evidence is distinguished from a valid empty log", async () => {
  cache(async () => undefined);
  expect((await readWorkerNotificationEvidence()).status).toBe("missing");
  cache(async () => { throw new Error("denied"); });
  expect((await readWorkerNotificationEvidence()).status).toBe("unavailable");
  cache(async () => new Response("{broken"));
  expect((await readWorkerNotificationEvidence()).status).toBe("unavailable");
  cache(async () => Response.json([]));
  expect(await readWorkerNotificationEvidence()).toEqual({ status: "ok", records: [] });
});

test("an unresponsive worker cache cannot strand the diagnostic download", async () => {
  cache(() => new Promise(() => {}));
  expect(await readWorkerNotificationEvidence()).toEqual({ status: "timeout", records: [] });
});
