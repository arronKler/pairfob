import { afterEach, beforeEach, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import {
  disableLocalNotifications,
  enableLocalNotifications,
  backgroundSyncEnabled,
  localNotificationsEnabled,
  localPushRevision,
  refreshLocalPush,
  subscribeLocalPush,
} from "./local-push";

type Sent = { method: string } & Record<string, unknown>;

function bridgeFixture(permission: "granted" | "denied" | "prompt" = "granted", backgroundSyncStarts = true) {
  const sent: Sent[] = [];
  const port = {
    postMessage(raw: string) {
      const request = JSON.parse(raw) as { id: string; method: string; on?: boolean };
      sent.push(request);
      const value = request.method === "status" ? { permission, backgroundSync: false }
        : request.method === "requestPermission" ? { permission }
        : request.method === "setBackgroundSync" ? { backgroundSync: backgroundSyncStarts && request.on === true }
        : request.method === "cancelAll" ? {}
        : { posted: true };
      port.onmessage?.({ data: JSON.stringify({ id: request.id, ok: true, value }) });
    },
    onmessage: null as ((event: { data: string }) => void) | null,
  };
  (window as unknown as { PairfobNotify?: typeof port }).PairfobNotify = port;
  return { port, sent };
}

beforeEach(async () => {
  delete (window as unknown as { PairfobNotify?: unknown }).PairfobNotify;
  localStorage.clear();
  // The background sync cache is module state; converge it through the public action.
  await disableLocalNotifications();
  localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { PairfobNotify?: unknown }).PairfobNotify;
  localStorage.clear();
});

test("enabling asks the OS, persists the choice and starts the background sync notification", async () => {
  const { sent } = bridgeFixture("granted");
  let publishes = 0;
  const stop = subscribeLocalPush(() => { publishes += 1; });
  const before = localPushRevision();
  await enableLocalNotifications();
  stop();
  expect(sent.map((item) => item.method)).toEqual(["requestPermission", "setBackgroundSync"]);
  expect(sent[1]).toMatchObject({ on: true });
  expect(localNotificationsEnabled()).toBeTrue();
  expect(backgroundSyncEnabled()).toBeTrue();
  expect(JSON.parse(localStorage.getItem("pairfob:localPush")!)).toEqual({ enabled: true, backgroundSync: true });
  expect(localPushRevision()).toBeGreaterThan(before);
  expect(publishes).toBe(1);
});

test("a denied permission throws and leaves notifications off", async () => {
  const { sent } = bridgeFixture("denied");
  await expect(enableLocalNotifications()).rejects.toThrow();
  expect(sent.map((item) => item.method)).toEqual(["requestPermission"]);
  expect(localNotificationsEnabled()).toBeFalse();
  expect(localStorage.getItem("pairfob:localPush")).toBeNull();
});

test("a background sync the system refuses leaves notifications off", async () => {
  const { sent } = bridgeFixture("granted", false);
  await expect(enableLocalNotifications()).rejects.toThrow();
  expect(sent.map((item) => item.method)).toEqual(["requestPermission", "setBackgroundSync"]);
  expect(localNotificationsEnabled()).toBeFalse();
  expect(backgroundSyncEnabled()).toBeFalse();
  expect(localStorage.getItem("pairfob:localPush")).toBeNull();
});

test("disabling persists off and clears both native carriers", async () => {
  const { sent } = bridgeFixture("granted");
  await enableLocalNotifications();
  sent.length = 0;
  await disableLocalNotifications();
  expect(localNotificationsEnabled()).toBeFalse();
  expect(backgroundSyncEnabled()).toBeFalse();
  expect(JSON.parse(localStorage.getItem("pairfob:localPush")!)).toEqual({ enabled: false, backgroundSync: false });
  expect(sent.map((item) => item.method).sort()).toEqual(["cancelAll", "setBackgroundSync"]);
  expect(sent.find((item) => item.method === "setBackgroundSync")).toMatchObject({ on: false });
});

test("refresh reports the bridge status and caches its background sync fact", async () => {
  const port = {
    postMessage(raw: string) {
      const request = JSON.parse(raw) as { id: string };
      port.onmessage?.({ data: JSON.stringify({ id: request.id, ok: true, value: { permission: "granted", backgroundSync: true } }) });
    },
    onmessage: null as ((event: { data: string }) => void) | null,
  };
  (window as unknown as { PairfobNotify?: typeof port }).PairfobNotify = port;
  expect(await refreshLocalPush()).toEqual({ permission: "granted", backgroundSync: true });
  expect(backgroundSyncEnabled()).toBeTrue();
});

test("every call is a no-op without the bridge", async () => {
  expect(await refreshLocalPush()).toBeNull();
  await enableLocalNotifications();
  await disableLocalNotifications();
  expect(localNotificationsEnabled()).toBeFalse();
  expect(backgroundSyncEnabled()).toBeFalse();
});

test("a persisted choice is read back without the bridge", () => {
  localStorage.setItem("pairfob:localPush", JSON.stringify({ enabled: true, backgroundSync: true }));
  expect(localNotificationsEnabled()).toBeTrue();
  localStorage.setItem("pairfob:localPush", "not json");
  expect(localNotificationsEnabled()).toBeFalse();
});
