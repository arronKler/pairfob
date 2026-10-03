import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";

// Real startApplication boot lifecycle: recoverable cold-start origin config
// failures re-arm retry eligibility so a later online/visible/pageshow event
// resumes the same boot, while invalid config never auto-retries, duplicate
// events coalesce, a stopped lifetime's late response is discarded, and a
// newer pairing intent is never overwritten. These run the real app boot
// (mount, network listeners, commit pipeline) with a controlled /api/config
// fetch — not source-string assertions.
await resetBoardTestDOM();

const telemetry = await import("../lib/telemetry");
telemetry.setTelemetrySender(() => {});

const { startApplication, stopApplication, applicationIsRunning } = await import("./bootstrap");
const { connectionStore, phase, setPhase, applyPairingFragment } = await import("../features/connection/connection-store");
const { visibleNotice } = await import("./notices-store");
const { connectionDiagnostics } = await import("../lib/protocol/connection-diagnostics");
const { registerSessionOwnerPreparer } = await import("./frame");
const { isAppMounted, unmountApp } = await import("./mount");
const { appHost, releaseAppHost } = await import("./host");
const { encodeCredential, SAVED_COUNT_KEY } = await import("../lib/credentials");
const { fingerprint16 } = await import("../lib/protocol/hello");

/** A saved computer on this origin; boot resumes it once config is read. */
const savedPair = {
  daemonId: "d_0123456789abcdefabcd", deviceId: "dev_abcdefgh",
  psk: new Uint8Array(32).fill(7), daemonPk: new Uint8Array(32).fill(2),
  fp: fingerprint16(new Uint8Array(32).fill(2)), relayOrigin: "https://pairfob.com",
  label: "Test phone", createdAt: 123,
};

/** A real config response the origin would serve on the fixed v2 protocol. */
function validConfigResponse(): Response {
  return Response.json({ protocol: 2, build: "boot-recoverable", p2p: false });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fetch stub that records every /api/config call and lets the test resolve
 * or reject each in arrival order. Boot drives exactly one call per boot run,
 * so arrival order is the boot order.
 */
function installConfigFetch() {
  const calls: Array<{ input: string; cache: string | undefined }> = [];
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  const log = {
    get count(): number {
      return calls.length;
    },
    get inFlight(): number {
      return pending.length;
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ input: String(input), cache: init?.cache });
      const control = deferred<Response>();
      pending.push(control);
      return control.promise;
    },
    resolveNext(response: Response): Promise<Response> {
      const control = pending.shift();
      if (!control) throw new Error("resolveNext with no pending config fetch");
      control.resolve(response);
      return control.promise;
    },
    rejectNext(error: unknown): Promise<Response> {
      const control = pending.shift();
      if (!control) throw new Error("rejectNext with no pending config fetch");
      control.reject(error);
      return control.promise;
    },
  };
  return log;
}

/** Drain the microtask chain boot's async continuation walks. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/**
 * Minimal in-memory IndexedDB so the real boot continuation (`reloadComputers`
 * → `loadCatalog`) runs to a settled empty catalog instead of rejecting here.
 * happy-dom ships no IndexedDB; the shim covers exactly the reads boot makes
 * (open/onsuccess, GET all credentials, GET one setting) with empty stores.
 */
function installIndexedDBShim(credentials: unknown[] = []): void {
  const stores = new Map<string, Map<string, unknown>>([
    ["credentials", new Map(credentials.map((value, index) => [String(index), value]))],
    ["settings", new Map()],
  ]);
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    transaction(name: string) {
      const snapshot = new Map(stores.get(name) ?? new Map());
      return {
        objectStore: () => ({
          getAll: () => idbRequest(() => Array.from(snapshot.values())),
          get: (key: string) => idbRequest(() => snapshot.get(key)),
          put: (value: unknown, key?: string) =>
            idbRequest(() => {
              if (key !== undefined) snapshot.set(String(key), value);
            }),
        }),
      };
    },
    close: () => {},
  };
  const open = () => idbRequest(() => db);
  (globalThis as Record<string, unknown>).indexedDB = { open };
}

function idbRequest<T>(run: () => T) {
  let onsuccess: (() => void) | null = null;
  let onerror: (() => void) | null = null;
  let onupgradeneeded: (() => void) | null = null;
  let fired = false;
  const request = {
    result: undefined as T | undefined,
    error: null as unknown,
    get onsuccess() {
      return onsuccess;
    },
    set onsuccess(fn: (() => void) | null) {
      onsuccess = fn;
    },
    get onerror() {
      return onerror;
    },
    set onerror(fn: (() => void) | null) {
      onerror = fn;
    },
    get onupgradeneeded() {
      return onupgradeneeded;
    },
    set onupgradeneeded(fn: (() => void) | null) {
      onupgradeneeded = fn;
    },
  };
  // IndexedDB fires async; wake on the next microtask so handlers attach first.
  queueMicrotask(() => {
    if (fired) return;
    fired = true;
    try {
      request.result = run();
      onupgradeneeded?.();
      onsuccess?.();
    } catch (error) {
      request.error = error;
      onerror?.();
    }
  });
  return request;
}

let fetchLog: ReturnType<typeof installConfigFetch>;
let originalFetch: typeof fetch;
let originalIndexedDB: PropertyDescriptor | undefined;
let originalOnline: PropertyDescriptor | undefined;

async function bootFailedOnRecoverable(statusOrError: unknown): Promise<void> {
  await act(async () => {
    startApplication();
  });
  await act(async () => {
    if (statusOrError instanceof Response) fetchLog.resolveNext(statusOrError);
    else fetchLog.rejectNext(statusOrError);
    await flushMicrotasks();
  });
  expect(fetchLog.count).toBe(1);
  expect(phase()).toBe("connect");
  expect(visibleNotice()?.tone).toBe("error");
}

function dispatchRecoveryEvents(): void {
  window.dispatchEvent(new happy.Event("online"));
  document.dispatchEvent(new happy.Event("visibilitychange"));
  window.dispatchEvent(new happy.Event("pageshow"));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  registerSessionOwnerPreparer(null);
  originalOnline = Object.getOwnPropertyDescriptor(navigator, "onLine");
  originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  localStorage.removeItem(SAVED_COUNT_KEY);
  installIndexedDBShim();
  fetchLog = installConfigFetch();
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchLog.fetch as typeof fetch;
  telemetry.resetTelemetry();
});

afterEach(async () => {
  registerSessionOwnerPreparer(null);
  if (applicationIsRunning()) await act(async () => { stopApplication(); await Promise.resolve(); });
  if (isAppMounted()) await act(async () => { unmountApp(); });
  const active = appHost();
  if (active) releaseAppHost(active);
  if (globalThis.fetch !== originalFetch) globalThis.fetch = originalFetch;
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else delete (globalThis as Record<string, unknown>).indexedDB;
  localStorage.removeItem(SAVED_COUNT_KEY);
  if (originalOnline) Object.defineProperty(navigator, "onLine", originalOnline);
  else delete (navigator as unknown as Record<string, unknown>).onLine;
  telemetry.resetTelemetry();
});

describe("cold-start origin config recovery", () => {
  for (const recovery of ["foreground", "button"] as const) test(`unavailable credential storage stays out of pairing and retries via ${recovery}`, async () => {
    const working = globalThis.indexedDB;
    (globalThis as Record<string, unknown>).indexedDB = {
      open() { throw new DOMException("Connection to Indexed Database server lost", "UnknownError"); },
    };
    await act(async () => { startApplication(); });
    await act(async () => {
      fetchLog.resolveNext(validConfigResponse());
      await flushMicrotasks();
    });
    expect(phase()).toBe("boot");
    expect(document.querySelector(".connect-scan")).toBeNull();
    expect(document.querySelector(".boot-recovery button")).not.toBeNull();
    expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "boot_decision", phase: "boot", code: "storage_unavailable" });

    (globalThis as Record<string, unknown>).indexedDB = working;
    await act(async () => {
      if (recovery === "foreground") dispatchRecoveryEvents();
      else document.querySelector<HTMLButtonElement>(".boot-recovery button")!.click();
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(2);
    await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
    // Only a successful empty read may decide that pairing is needed.
    expect(phase()).toBe("connect");
    expect(visibleNotice()).toBeNull();
    expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "boot_decision", phase: "connect", code: "ok", usable_count: 0 });
  });

  test("storage recovery retries automatically and discards callbacks from a stopped lifetime", async () => {
    const working = globalThis.indexedDB;
    (globalThis as Record<string, unknown>).indexedDB = {
      open() { throw new Error("Storage service unavailable"); },
    };
    const retry: (() => void)[] = [];
    const original = window.setTimeout.bind(window);
    const timer = spyOn(window, "setTimeout").mockImplementation(((fn: () => void, delay: number, ...args: unknown[]) => {
      if (delay === 1500 || delay === 3000) { retry.push(fn); return 987654; }
      return original(fn, delay, ...args);
    }) as typeof window.setTimeout);
    try {
      await act(async () => { startApplication(); });
      await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
      expect(phase()).toBe("boot");
      expect(retry).toHaveLength(1);
      await act(async () => { retry[0](); await flushMicrotasks(); });
      expect(fetchLog.count).toBe(2);
      await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
      expect(retry).toHaveLength(2);
      await act(async () => { stopApplication(); });
      (globalThis as Record<string, unknown>).indexedDB = working;
      await act(async () => { retry[1](); await flushMicrotasks(); });
      expect(fetchLog.count).toBe(2);
      expect(applicationIsRunning()).toBeFalse();
    } finally { timer.mockRestore(); }
  });

  test("credential retry events cannot replace a newer pairing attempt", async () => {
    (globalThis as Record<string, unknown>).indexedDB = {
      open() { throw new Error("Storage service unavailable"); },
    };
    await act(async () => { startApplication(); });
    await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
    expect(phase()).toBe("boot");
    await act(async () => {
      applyPairingFragment({ v: 2, pairRef: "0123456789abcdef", code: "ABCD1234" });
      setPhase("pairing");
      dispatchRecoveryEvents();
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(1);
    expect(phase()).toBe("pairing");
    expect(connectionStore.get().bootBlocked).toBeNull();
  });

  test("a refused config read re-arms boot and an online event resumes it to a settled connect", async () => {
    await act(async () => { startApplication(); });
    expect(fetchLog.count).toBe(1);
    expect(applicationIsRunning()).toBeTrue();

    await act(async () => {
      fetchLog.rejectNext(new TypeError("Failed to fetch"));
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(1);
    expect(phase()).toBe("connect");
    expect(visibleNotice()?.tone).toBe("error");

    // A later online event must resume the same boot: a second config read.
    await act(async () => {
      window.dispatchEvent(new happy.Event("online"));
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(2);

    await act(async () => {
      fetchLog.resolveNext(validConfigResponse());
      await flushMicrotasks();
    });
    // Recovery finished inside the same mount: catalog settled, back on
    // connect with no error and no new start required.
    expect(fetchLog.count).toBe(2);
    expect(phase()).toBe("connect");
    expect(visibleNotice()).toBeNull();
    expect(applicationIsRunning()).toBeTrue();
  });

  test("an unavailable origin status and duplicate recovery events coalesce to one retry", async () => {
    await bootFailedOnRecoverable(new Response("", { status: 503 }));

    await act(async () => {
      dispatchRecoveryEvents();
      await flushMicrotasks();
    });
    // The same-round online/visible/pageshow events resume boot exactly once.
    expect(fetchLog.count).toBe(2);
    expect(fetchLog.inFlight).toBe(1);

    // While the resumed config read is in flight another event starts nothing.
    await act(async () => {
      window.dispatchEvent(new happy.Event("online"));
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(2);

    await act(async () => {
      fetchLog.resolveNext(validConfigResponse());
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(2);
    expect(phase()).toBe("connect");
    expect(visibleNotice()).toBeNull();
  });

  test("invalid config never auto-retries, even on recovery events", async () => {
    await act(async () => { startApplication(); });
    await act(async () => {
      // Origin answered, but with an unsupported protocol version.
      fetchLog.resolveNext(Response.json({ protocol: 1, build: "legacy" }));
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(1);
    expect(phase()).toBe("connect");
    expect(visibleNotice()?.tone).toBe("error");

    await act(async () => {
      dispatchRecoveryEvents();
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(1);
    expect(phase()).toBe("connect");
    expect(visibleNotice()?.tone).toBe("error");
  });

  test("an offline hint still reads config, and a later real read resumes without an online event", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await act(async () => { startApplication(); });
    // The hint never gates the read: boot asks the origin anyway.
    expect(fetchLog.count).toBe(1);
    await act(async () => { fetchLog.rejectNext(new TypeError("Failed to fetch")); await flushMicrotasks(); });
    expect(phase()).toBe("connect");
    expect(connectionStore.get().networkOnline).toBe(false);
    expect(visibleNotice()?.tone).toBe("status");

    // The browser never fires `online`; the reachability probe confirms instead.
    expect(fetchLog.count).toBe(2);
    await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
    expect(fetchLog.count).toBe(3);
    await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
    expect(phase()).toBe("connect");
    expect(connectionStore.get().networkOnline).toBe(true);
    expect(visibleNotice()).toBeNull();
  });

  test("a late config failure from a stopped lifetime never re-arms or repaints", async () => {
    await act(async () => { startApplication(); });
    expect(fetchLog.count).toBe(1);

    await act(async () => { stopApplication(); });
    expect(applicationIsRunning()).toBeFalse();

    await act(async () => { startApplication(); });
    expect(applicationIsRunning()).toBeTrue();
    expect(fetchLog.count).toBe(2);
    expect(phase()).toBe("boot");

    // The first lifetime's config read fails after the replacement started.
    await act(async () => {
      fetchLog.rejectNext(new TypeError("Failed to fetch"));
      await flushMicrotasks();
    });
    // Discarded: no error paint, no phase change, the replacement keeps boot.
    expect(fetchLog.count).toBe(2);
    expect(phase()).toBe("boot");
    expect(visibleNotice()).toBeNull();
    expect(applicationIsRunning()).toBeTrue();

    await act(async () => {
      fetchLog.resolveNext(validConfigResponse());
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(2);
    expect(phase()).toBe("connect");
    expect(visibleNotice()).toBeNull();
  });

  test("a newer pairing intent is never overwritten by a recovery event", async () => {
    await act(async () => { startApplication(); });
    await act(async () => {
      fetchLog.resolveNext(new Response("", { status: 503 }));
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(1);
    expect(phase()).toBe("connect");

    // While connect is blocked the user starts a newer pairing intent.
    const intent = Object.freeze({ v: 2 as const, pairRef: "0123456789abcdef", code: "ABCD1234" });
    await act(async () => {
      applyPairingFragment(intent);
      setPhase("pairing");
    });
    expect(connectionStore.get()?.fragment).not.toBeNull();

    await act(async () => {
      dispatchRecoveryEvents();
      await flushMicrotasks();
    });
    // The pairing phase is a newer intent: recovery must not re-boot over it.
    expect(fetchLog.count).toBe(1);
    expect(phase()).toBe("pairing");
    expect(connectionStore.get()?.fragment).not.toBeNull();
  });
});

describe("saved computers never fall through to pairing", () => {
  function captureRetryTimers(): { retry: Array<() => void>; restore: () => void } {
    const retry: Array<() => void> = [];
    const original = window.setTimeout.bind(window);
    const timer = spyOn(window, "setTimeout").mockImplementation(((fn: () => void, delay: number, ...args: unknown[]) => {
      if (delay === 1500 || delay === 3000) { retry.push(fn); return 987654; }
      return original(fn, delay, ...args);
    }) as typeof window.setTimeout);
    return { retry, restore: () => timer.mockRestore() };
  }

  test("an unreachable origin holds boot with saved computers and retries automatically", async () => {
    installIndexedDBShim([encodeCredential(savedPair)]);
    const timers = captureRetryTimers();
    try {
      await act(async () => { startApplication(); });
      await act(async () => { fetchLog.rejectNext(new TypeError("Failed to fetch")); await flushMicrotasks(); });
      expect(phase()).toBe("boot");
      expect(document.querySelector(".connect-scan")).toBeNull();
      expect(document.querySelector(".boot-recovery")?.getAttribute("data-block")).toBe("origin");
      expect(document.querySelector(".boot-pair-anyway")).toBeNull();
      expect(connectionDiagnostics().at(-1)).toMatchObject({ event: "boot_decision", code: "bad_relay", reason: "boot" });
      expect(timers.retry).toHaveLength(1);

      await act(async () => { timers.retry[0](); await flushMicrotasks(); });
      expect(fetchLog.count).toBe(2);
      await act(async () => { fetchLog.resolveNext(new Response("", { status: 503 })); await flushMicrotasks(); });
      expect(phase()).toBe("boot");
      expect(timers.retry).toHaveLength(2);

      await act(async () => { timers.retry[1](); await flushMicrotasks(); });
      await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
      expect(connectionStore.get().bootBlocked).toBeNull();
      expect(connectionDiagnostics().some((item) => item.event === "boot_decision" && item.code === "ok" && item.reason === "resume")).toBeTrue();
    } finally { timers.restore(); }
  });

  test("an invalid origin config still reports on the connect page", async () => {
    installIndexedDBShim([encodeCredential(savedPair)]);
    await act(async () => { startApplication(); });
    await act(async () => { fetchLog.resolveNext(Response.json({ protocol: 1, build: "legacy" })); await flushMicrotasks(); });
    expect(phase()).toBe("connect");
    expect(visibleNotice()?.tone).toBe("error");
  });

  test("a stuck offline hint with a reachable origin resumes saved computers", async () => {
    installIndexedDBShim([encodeCredential(savedPair)]);
    // Android Chrome after a return from the background: onLine stays false.
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await act(async () => { startApplication(); });
    expect(fetchLog.count).toBe(1);
    await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
    expect(document.querySelector(".boot-recovery")).toBeNull();
    expect(document.querySelector(".connect-scan")).toBeNull();
    expect(connectionStore.get().networkOnline).toBe(true);
    expect(connectionDiagnostics().some((item) => item.event === "network_lifecycle" && item.reason === "online_hint_stale")).toBeTrue();
    expect(connectionDiagnostics().some((item) => item.event === "boot_decision" && item.code === "ok" && item.reason === "resume")).toBeTrue();
  });

  test("an offline hold retries automatically and on tap while the hint stays offline", async () => {
    installIndexedDBShim([encodeCredential(savedPair)]);
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const timers = captureRetryTimers();
    try {
      await act(async () => { startApplication(); });
      await act(async () => { fetchLog.rejectNext(new TypeError("Failed to fetch")); await flushMicrotasks(); });
      expect(phase()).toBe("boot");
      expect(document.querySelector(".boot-recovery")?.getAttribute("data-block")).toBe("offline");
      expect(timers.retry).toHaveLength(1);

      await act(async () => { timers.retry[0](); await flushMicrotasks(); });
      expect(fetchLog.count).toBe(2);
      await act(async () => { fetchLog.rejectNext(new TypeError("Failed to fetch")); await flushMicrotasks(); });
      expect(document.querySelector(".boot-recovery")?.getAttribute("data-block")).toBe("offline");

      // The hint still says offline; a tap is a real read regardless.
      await act(async () => {
        document.querySelector<HTMLButtonElement>(".boot-recovery .btn")!.click();
        await flushMicrotasks();
      });
      expect(fetchLog.count).toBe(3);
      await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
      expect(connectionStore.get().bootBlocked).toBeNull();
      expect(connectionStore.get().networkOnline).toBe(true);
    } finally { timers.restore(); }
  });

  test("an empty store where computers were saved holds boot; pairing again is an explicit choice", async () => {
    localStorage.setItem(SAVED_COUNT_KEY, "2");
    await act(async () => { startApplication(); });
    await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
    expect(phase()).toBe("boot");
    expect(document.querySelector(".connect-scan")).toBeNull();
    expect(document.querySelector(".boot-recovery")?.getAttribute("data-block")).toBe("storage");
    expect(connectionDiagnostics().some((item) => item.event === "catalog_failed" && item.code === "storage_empty")).toBeTrue();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".boot-pair-anyway")!.click();
      await flushMicrotasks();
    });
    expect(fetchLog.count).toBe(2);
    await act(async () => { fetchLog.resolveNext(validConfigResponse()); await flushMicrotasks(); });
    expect(phase()).toBe("connect");
    expect(localStorage.getItem(SAVED_COUNT_KEY)).toBeNull();
  });
});
