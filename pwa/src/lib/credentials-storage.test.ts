import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CREDENTIAL_READ_TIMEOUT_MS, encodeCredential, loadCatalog } from "./credentials";
import { fingerprint16 } from "./protocol/hello";

const pair = {
  daemonId: "d_0123456789abcdefabcd", deviceId: "dev_abcdefgh",
  psk: new Uint8Array(32).fill(7), daemonPk: new Uint8Array(32).fill(2),
  fp: fingerprint16(new Uint8Array(32).fill(2)), relayOrigin: "https://pairfob.com",
  label: "Test phone", createdAt: 123,
};
let original: PropertyDescriptor | undefined;
const timers = new Map<number, () => void>();
let timeout: ReturnType<typeof spyOn>;
let clear: ReturnType<typeof spyOn>;

beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  let serial = 0;
  timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
    expect(ms).toBe(CREDENTIAL_READ_TIMEOUT_MS);
    const id = ++serial;
    timers.set(id, fn);
    return id;
  }) as typeof setTimeout);
  clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout);
});

afterEach(() => {
  timeout.mockRestore(); clear.mockRestore(); timers.clear();
  if (original) Object.defineProperty(globalThis, "indexedDB", original);
  else delete (globalThis as Record<string, unknown>).indexedDB;
});

function request<T>(result: T) {
  return { result, error: null as Error | null, readyState: "pending",
    onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
}

function install(mode: "ok" | "stalled-open" | "stalled-read" | "aborted-read" | "settings-error" | "read-error") {
  const stored = encodeCredential(pair);
  let closed = 0, aborted = 0;
  const opens: ReturnType<typeof request<typeof db>>[] = [];
  const db = {
    objectStoreNames: { contains: () => true },
    onversionchange: null as (() => void) | null,
    close: () => { closed++; },
    transaction(name: string) {
      if (name === "settings" && mode === "settings-error") throw new Error("Storage service unavailable");
      const tx = {
        error: null as Error | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        abort() { aborted++; tx.onabort?.(); },
        objectStore() {
          const read = <T>(value: T) => {
            const req = request(value);
            queueMicrotask(() => {
              if (mode === "stalled-read") return;
              if (mode === "aborted-read") { tx.error = new Error("Storage transaction aborted"); tx.onabort?.(); return; }
              req.readyState = "done";
              if (mode === "read-error") { req.error = new Error("Read failed"); req.onerror?.(); }
              else req.onsuccess?.();
            });
            return req;
          };
          return { getAll: () => read([stored]), get: () => read(pair.daemonId) };
        },
      };
      return tx;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open() {
      const req = request(db); opens.push(req);
      if (mode !== "stalled-open") queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  } });
  return { opens, db, stored, get closed() { return closed; }, get aborted() { return aborted; } };
}

async function flush() { for (let n = 0; n < 15; n++) await Promise.resolve(); }
function expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }

test("a successful read returns the saved identity and releases both database handles", async () => {
  const storage = install("ok");
  expect(await loadCatalog(pair.relayOrigin)).toEqual({ credentials: [pair], lastUsedDaemonId: pair.daemonId });
  expect(storage.closed).toBe(2);
  expect(timers.size).toBe(0);
});

test("a last-used hint failure never hides the validated credential", async () => {
  const storage = install("settings-error");
  expect(await loadCatalog(pair.relayOrigin)).toEqual({ credentials: [pair], lastUsedDaemonId: null });
  expect(storage.closed).toBe(2);
});

for (const mode of ["read-error", "aborted-read"] as const) {
  test(`${mode} rejects instead of returning an empty catalog`, async () => {
    const storage = install(mode);
    await expect(loadCatalog(pair.relayOrigin)).rejects.toBeInstanceOf(Error);
    expect(storage.closed).toBe(1);
    expect(storage.stored).toEqual(encodeCredential(pair));
    expect(timers.size).toBe(0);
  });
}

test("a silent read times out, aborts its transaction and releases the connection", async () => {
  const storage = install("stalled-read");
  const result = loadCatalog(pair.relayOrigin).catch((error) => error);
  await flush(); expire();
  expect((await result).name).toBe("TimeoutError");
  expect(storage.aborted).toBe(1);
  expect(storage.closed).toBe(1);
});

test("a late open after timeout is closed and cannot publish an empty catalog", async () => {
  const storage = install("stalled-open");
  const result = loadCatalog(pair.relayOrigin).catch((error) => error);
  expire();
  expect((await result).name).toBe("TimeoutError");
  storage.opens[0].onsuccess?.();
  expect(storage.closed).toBe(1);
  // A fresh open recovers without deleting or replacing any credential.
  install("ok");
  expect((await loadCatalog(pair.relayOrigin)).credentials).toEqual([pair]);
});
