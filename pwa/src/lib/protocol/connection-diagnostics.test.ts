import { expect, test, spyOn } from "bun:test";
import { connectionDiagnostics, recordConnectionDiagnostic } from "./connection-diagnostics";

test("diagnostics stay bounded and omit unclassified strings and payloads even with storage blocked", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    for (let i = 0; i < 205; i++) recordConnectionDiagnostic({ event: "disconnect", pending_rpcs: i });
    expect(connectionDiagnostics()).toHaveLength(200);
    recordConnectionDiagnostic({ event: "disconnect", reason: "secret 192.0.2.1", code: "token-secret", route_id: "../../private", sdp: "secret" } as never);
    const record = connectionDiagnostics().at(-1)!;
    expect(record.reason).toBe("other");
    expect(record.code).toBe("other");
    expect(record.route_id).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("secret");
    record.event = "tampered";
    expect(connectionDiagnostics().at(-1)!.event).toBe("disconnect");
    const now = spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 1);
    try { expect(connectionDiagnostics()).toHaveLength(0); } finally { now.mockRestore(); }
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("reload restores sanitized recent records and discards stale or malformed storage", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  let stored = JSON.stringify([
    { at: Date.now(), event: "disconnect", reason: "heartbeat_timeout", route_id: "ab".repeat(16), secret: "private" },
    { at: Date.now() - 25 * 60 * 60 * 1000, event: "disconnect" },
    { at: "invalid", event: "disconnect" },
  ]);
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } });
  const fresh = async (name: string): Promise<typeof import("./connection-diagnostics")> => import(`./connection-diagnostics.ts?${name}`);
  try {
    const first = await fresh("restore");
    expect(first.connectionDiagnostics()).toHaveLength(1);
    expect(JSON.stringify(first.connectionDiagnostics())).not.toContain("private");
    first.recordConnectionDiagnostic({ event: "page_visible", route_id: "ab".repeat(16) });
    const reloaded = await fresh("reload");
    expect(reloaded.connectionDiagnostics().map((record) => record.event)).toEqual(["disconnect", "page_visible"]);
    stored = "{broken";
    expect((await fresh("corrupt")).connectionDiagnostics()).toHaveLength(0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("handshake timings preserve only finite nonnegative numbers", () => {
  recordConnectionDiagnostic({ event: "hello_verified", connect_id: 7, elapsed_ms: 125.3 });
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "hello_verified", connect_id: 7, elapsed_ms: 125 });
  recordConnectionDiagnostic({ event: "session_ready", connect_id: -1, elapsed_ms: Infinity });
  expect(connectionDiagnostics().at(-1)?.connect_id).toBeUndefined();
  expect(connectionDiagnostics().at(-1)?.elapsed_ms).toBeUndefined();
});

test("notification evidence correlates stages without persisting notification targets", () => {
  recordConnectionDiagnostic({ event: "notify_received", reason: "worker_message", notification_id: 7,
    url: "https://pairfob.com/pair#secret", pane_id: "private-pane", daemon_id: "private-daemon" } as never);
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "notify_received", reason: "worker_message", notification_id: 7 });
  expect(JSON.stringify(connectionDiagnostics().at(-1))).not.toMatch(/secret|private/);
  recordConnectionDiagnostic({ event: "notify_deferred", reason: "hidden", notification_id: Infinity });
  expect(connectionDiagnostics().at(-1)?.notification_id).toBeUndefined();
});

test("catalog and boot evidence survives the sanitizer without accepting arbitrary fields", () => {
  recordConnectionDiagnostic({ event: "boot_decision", phase: "connect", previous_phase: "boot",
    reason: "connect", code: "ok", usable_count: 0 });
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "boot_decision", phase: "connect",
    previous_phase: "boot", reason: "connect", code: "ok", usable_count: 0 });
  recordConnectionDiagnostic({ event: "catalog_read", stored_count: 3, usable_count: 1,
    invalid_count: -1, other_origin_count: Infinity, phase: "private name", daemon_id: "secret" } as never);
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "catalog_read", stored_count: 3, usable_count: 1, phase: "other" });
  expect(connectionDiagnostics().at(-1)?.invalid_count).toBeUndefined();
  expect(connectionDiagnostics().at(-1)?.other_origin_count).toBeUndefined();
  expect(JSON.stringify(connectionDiagnostics().at(-1))).not.toContain("secret");
});
