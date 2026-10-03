import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CREDENTIAL_READ_TIMEOUT_MS, SAVED_COUNT_KEY, deleteCredential, encodeCredential, forgetSavedComputerCount,
  loadCatalog, saveCredential, savedComputerCount,
} from "./credentials";
import { fingerprint16 } from "./protocol/hello";
import { connectionDiagnostics } from "./protocol/connection-diagnostics";

const pair = {
  daemonId: "d_0123456789abcdefabcd", deviceId: "dev_abcdefgh",
  psk: new Uint8Array(32).fill(7), daemonPk: new Uint8Array(32).fill(2),
  fp: fingerprint16(new Uint8Array(32).fill(2)), relayOrigin: "https://pairfob.com",
  label: "Test phone", createdAt: 123,
};
let original: PropertyDescriptor | undefined;
let originalStorage: PropertyDescriptor | undefined;
const timers = new Map<number, () => void>();
let timeout: ReturnType<typeof spyOn>;
let clear: ReturnType<typeof spyOn>;

/** This file runs without a DOM; the saved-computer count needs only a key/value store. */
function installLocalStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  } });
}

beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  installLocalStorage();
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
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else delete (globalThis as Record<string, unknown>).localStorage;
  timeout.mockRestore(); clear.mockRestore(); timers.clear();
  if (original) Object.defineProperty(globalThis, "indexedDB", original);
  else delete (globalThis as Record<string, unknown>).indexedDB;
});

function request<T>(result: T) {
  return { result, error: null as Error | null, readyState: "pending",
    onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
}

function install(mode: "ok" | "stalled-open" | "stalled-read" | "aborted-read" | "settings-error" | "read-error", values?: unknown[]) {
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
          return { getAll: () => read(values ?? [stored]), get: () => read(pair.daemonId) };
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
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "catalog_hint_failed", code: "storage_error" });
});

for (const mode of ["read-error", "aborted-read"] as const) {
  test(`${mode} rejects instead of returning an empty catalog`, async () => {
    const storage = install(mode);
    await expect(loadCatalog(pair.relayOrigin)).rejects.toBeInstanceOf(Error);
    expect(storage.closed).toBe(1);
    expect(storage.stored).toEqual(encodeCredential(pair));
    expect(timers.size).toBe(0);
    expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "catalog_failed", code: "storage_error" });
  });
}

test("a silent read times out, aborts its transaction and releases the connection", async () => {
  const storage = install("stalled-read");
  const result = loadCatalog(pair.relayOrigin).catch((error) => error);
  await flush(); expire();
  expect((await result).name).toBe("TimeoutError");
  expect(storage.aborted).toBe(1);
  expect(storage.closed).toBe(1);
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "catalog_failed", code: "storage_timeout" });
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

test("catalog diagnostics distinguish an empty database from filtered records without exposing identity", async () => {
  install("ok", []);
  expect((await loadCatalog(pair.relayOrigin)).credentials).toEqual([]);
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "catalog_read", stored_count: 0,
    usable_count: 0, invalid_count: 0, other_origin_count: 0 });

  const stored = encodeCredential(pair);
  install("ok", [stored, { ...stored, fp: "invalid" }, { ...stored, relay_origin: "https://elsewhere.example" }]);
  expect((await loadCatalog(pair.relayOrigin)).credentials).toEqual([pair]);
  const diagnostic = connectionDiagnostics().at(-1);
  expect(diagnostic).toMatchObject({ event: "catalog_read", stored_count: 3,
    usable_count: 1, invalid_count: 1, other_origin_count: 1 });
  for (const value of [pair.daemonId, pair.deviceId, stored.device_psk, stored.daemon_pk, pair.label, pair.relayOrigin]) {
    expect(JSON.stringify(diagnostic)).not.toContain(value);
  }
});

test("an empty store after computers were seen is a storage failure, not an empty catalog", async () => {
  install("ok");
  await loadCatalog(pair.relayOrigin);
  expect(savedComputerCount()).toBe(1);

  install("ok", []);
  const error = await loadCatalog(pair.relayOrigin).catch((reason) => reason);
  expect(error.name).toBe("EmptyCatalogError");
  expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "catalog_failed", code: "storage_empty" });
  expect(savedComputerCount()).toBe(1);

  forgetSavedComputerCount();
  expect((await loadCatalog(pair.relayOrigin)).credentials).toEqual([]);
});

/** A write transaction whose store reports `after` records once it commits. */
function installWritable(after: number) {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open() {
      const db = {
        objectStoreNames: { contains: () => true },
        onversionchange: null as (() => void) | null,
        close() {},
        transaction() {
          const tx = { oncomplete: null as (() => void) | null, onerror: null, onabort: null,
            objectStore: () => ({
              put: () => {},
              delete: () => {},
              count: () => ({ result: after }),
            }) };
          queueMicrotask(() => tx.oncomplete?.());
          return tx;
        },
      };
      const req = request(db);
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  } });
}

test("saving and deleting keep the saved-computer count in step with the store", async () => {
  installWritable(2);
  await saveCredential(pair);
  expect(savedComputerCount()).toBe(2);

  installWritable(0);
  await deleteCredential(pair.daemonId);
  expect(savedComputerCount()).toBe(0);
  expect(localStorage.getItem(SAVED_COUNT_KEY)).toBeNull();
});
