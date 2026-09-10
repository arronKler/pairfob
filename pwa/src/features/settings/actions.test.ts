import { afterEach, expect, test } from "bun:test";
import { attachLiveSession } from "../computers/catalog-store";
import { beginSettingsRead, resetRuntime, runtimeStore, setPushEnabled, setPushSubscribed } from "../connection/runtime-store";
import { setScreen } from "../../app/navigation-store";
import { clearNotice } from "../../app/notices-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { enablePush, refreshSettings, settingsReadStillOwned } from "./actions";

const validConfig = (push = true) => ({
  protocol: 1,
  build: "1.0.0",
  daemon_id: "d_aaaaaaaaaaaaaaaaaaaa",
  hostname: "host",
  runtime: "herdr",
  vapid_public: "AA",
  submit_keys: ["Enter"],
  idle_pause_ms: 30_000,
  push_delivery: "webpush",
  push_enabled: push,
  capabilities: { ...NO_OPERATION_CAPABILITIES },
  agent_kinds: [],
});

afterEach(() => {
  attachLiveSession(null);
  resetRuntime();
  setScreen("home");
  clearNotice();
});

test("a settings read for a replaced session cannot write the new panel", async () => {
  let resolveFirst!: (value: { devices: [] }) => void;
  const first = {
    isConnected: () => true,
    listDevices: () => new Promise<{ devices: [] }>(resolve => { resolveFirst = resolve; }),
    getConfig: async () => ({}),
  } as unknown as LiveSession;
  const second = {
    isConnected: () => true,
    listDevices: async () => ({ devices: [{ device_id: "dev_new", label: "Phone", current: true, self: true }] }),
    getConfig: async () => ({ push_enabled: true }),
  } as unknown as LiveSession;

  attachLiveSession(first);
  setScreen("settings");
  const pending = refreshSettings();
  attachLiveSession(second);
  beginSettingsRead();
  resolveFirst({ devices: [] });
  await pending;
  expect(runtimeStore.get().deviceList).toEqual([]);
  await refreshSettings();
  expect(runtimeStore.get().deviceList.map(device => device.device_id)).toEqual(["dev_new"]);
});

test("a runtime subscriber that switches computers cannot inherit the rest of the old config write", async () => {
  const old = {
    isConnected: () => true,
    listDevices: async () => ({ devices: [{ device_id: "OLD", label: "old", created_at: 1, self: false, connected: false }] }),
    getConfig: async () => ({ push_enabled: true }),
  } as unknown as LiveSession;
  const next = {
    isConnected: () => true,
    listDevices: async () => ({ devices: [] }),
    getConfig: async () => ({ push_enabled: false }),
  } as unknown as LiveSession;
  attachLiveSession(old);
  let switched = false;
  const stop = runtimeStore.subscribe(() => {
    if (switched || runtimeStore.get().deviceList[0]?.device_id !== "OLD") return;
    switched = true;
    attachLiveSession(next);
    resetRuntime();
    setPushEnabled(false);
    setPushSubscribed(false);
  });
  try {
    await refreshSettings();
  } finally {
    stop();
  }
  expect(switched).toBeTrue();
  expect(settingsReadStillOwned(0, old)).toBeFalse();
  expect(runtimeStore.get().pushEnabled).toBeFalse();
  expect(runtimeStore.get().deviceList).toEqual([]);
});

test("loading publication that switches computers does not start the old session RPCs", async () => {
  let aDevices = 0;
  let aConfig = 0;
  const a = {
    isConnected: () => true,
    listDevices: async () => { aDevices += 1; return { devices: [] }; },
    getConfig: async () => { aConfig += 1; return validConfig(); },
  } as unknown as LiveSession;
  const b = {
    isConnected: () => true,
    listDevices: async () => ({ devices: [] }),
    getConfig: async () => validConfig(false),
  } as unknown as LiveSession;
  attachLiveSession(a);
  let switched = false;
  const stop = runtimeStore.subscribe(() => {
    if (switched || !runtimeStore.get().settingsLoading) return;
    switched = true;
    attachLiveSession(b);
    resetRuntime();
    setPushEnabled(false);
  });
  try {
    await refreshSettings();
  } finally {
    stop();
  }
  expect(switched).toBeTrue();
  expect(aDevices).toBe(0);
  expect(aConfig).toBe(0);
  expect(runtimeStore.get().pushEnabled).toBeFalse();
});

test("a newer settings read started during loading publication retires the outer RPCs", async () => {
  let devices = 0;
  let configs = 0;
  let inner: Promise<void> | undefined;
  const current = {
    isConnected: () => true,
    listDevices: async () => {
      devices += 1;
      return { devices: [{ device_id: "CURRENT", label: "now", created_at: 1, self: false, connected: false }] };
    },
    getConfig: async () => { configs += 1; return validConfig(); },
  } as unknown as LiveSession;
  attachLiveSession(current);
  let reentered = false;
  const stop = runtimeStore.subscribe(() => {
    if (reentered || !runtimeStore.get().settingsLoading) return;
    reentered = true;
    inner = refreshSettings();
  });
  try {
    await refreshSettings();
    await inner;
  } finally {
    stop();
  }
  expect(reentered).toBeTrue();
  expect(devices).toBe(1);
  expect(configs).toBe(1);
  expect(runtimeStore.get().settingsLoading).toBeFalse();
  expect(runtimeStore.get().deviceList[0]?.device_id).toBe("CURRENT");
});

test("enablePush that is authorized after a computer switch does not write or toast the replacement", async () => {
  let grant!: (value: NotificationPermission) => void;
  const permission = new Promise<NotificationPermission>(resolve => { grant = resolve; });
  const subscription = { toJSON: () => ({ endpoint: "https://push.local/id" }) };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription, subscribe: async () => subscription } }),
      getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } }),
    },
  });
  Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
  const notification = { requestPermission: () => permission };
  Object.defineProperty(window, "Notification", { configurable: true, value: notification });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: notification });

  let aWrites = 0;
  let bReads = 0;
  const a = {
    isConnected: () => true,
    getConfig: async () => validConfig(true),
    pushSubscribe: async () => { aWrites += 1; },
    listDevices: async () => ({ devices: [] }),
  } as unknown as LiveSession;
  const b = {
    isConnected: () => true,
    getConfig: async () => { bReads += 1; return { push_enabled: false }; },
    listDevices: async () => ({ devices: [] }),
  } as unknown as LiveSession;
  attachLiveSession(a);
  const pending = enablePush();
  for (let i = 0; i < 16; i++) await Promise.resolve();
  attachLiveSession(b);
  resetRuntime();
  grant("granted");
  await pending;
  expect(aWrites).toBe(0);
  expect(bReads).toBe(0);
  expect(runtimeStore.get().pushSubscribed).toBeNull();
});
