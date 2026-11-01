import { afterEach, beforeEach, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { bindNotificationLinks } from "./notification-links";
import { publishAllDomains } from "./domain-publication";
import {
  captureNotificationTarget, clearNotificationTarget, notificationTarget, setNetworkOnline, setPhase,
} from "../features/connection/connection-store";
import { attachLiveSession, setComputers, setCredential } from "../features/computers/catalog-store";
import { openPendingNotification } from "../features/settings/notifications";
import { applySnapshot, resetDashboard } from "../features/dashboard/catalog-store";
import type { PairResult } from "../lib/protocol/client";

const pair = (char: string) => ({ daemonId: `d_${char.repeat(20)}`, deviceId: "device", label: "test",
  relayOrigin: "https://pairfob.com", createdAt: 1, fp: "fp",
  psk: new Uint8Array(32), daemonPk: new Uint8Array(32) }) as PairResult;
const a = pair("a"), b = pair("b");
let controller: AbortController;

type NativePort = {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
};

/** A native notification port that answers `ready`, optionally with a cold-start tap. */
function nativeFixture(coldTap: string | null = null): NativePort {
  const port: NativePort = {
    postMessage(raw) {
      const request = JSON.parse(raw) as { id: string; method: string };
      if (request.method !== "ready") return;
      port.onmessage?.({ data: JSON.stringify({ id: request.id, ok: true, value: { tap: coldTap ? { url: coldTap } : null } }) });
    },
    onmessage: null,
  };
  (window as unknown as { PairfobNotify?: NativePort }).PairfobNotify = port;
  return port;
}

function tap(port: NativePort, url: string) {
  port.onmessage?.({ data: JSON.stringify({ event: "tap", url }) });
}

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function capture(daemonId: string, paneId = "p1") { captureNotificationTarget({ daemonId, paneId }); }

beforeEach(async () => {
  await resetBoardTestDOM();
  controller = new AbortController();
  clearNotificationTarget();
  attachLiveSession(null);
  setComputers([a, b]);
  setCredential(a);
  setNetworkOnline(true);
  setPhase("live");
  applySnapshot({ panes: [{ pane_id: "p1" }, { pane_id: "p2" }] });
  publishAllDomains();
});
afterEach(() => {
  controller.abort();
  clearNotificationTarget();
  setCredential(null);
  setComputers([]);
  resetDashboard();
  setPhase("boot");
  delete (window as unknown as { PairfobNotify?: unknown }).PairfobNotify;
});

test("a warm notification switches computers before consuming the pane target", async () => {
  const calls: string[] = [];
  bindNotificationLinks(controller.signal, {
    switchComputer: async daemonId => {
      calls.push(`switch:${daemonId}`);
      setCredential(b);
      await openPendingNotification(async paneId => { calls.push(`open:${paneId}`); }, async () => false);
    },
    refresh: async () => { throw new Error("must switch first"); },
  });
  capture(b.daemonId);
  await flush();
  expect(calls).toEqual([`switch:${b.daemonId}`, "open:p1"]);
  expect(notificationTarget()).toBeNull();
});

test("the newest click arriving during a computer switch wins", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  bindNotificationLinks(controller.signal, {
    switchComputer: async daemonId => {
      calls.push(`switch:${daemonId}`);
      if (daemonId === b.daemonId) await pending;
      setCredential(daemonId === b.daemonId ? b : a);
      await openPendingNotification(async paneId => { calls.push(`open:${paneId}`); }, async () => false);
    },
    refresh: async () => { throw new Error("must switch first"); },
  });
  capture(b.daemonId);
  await flush();
  capture(a.daemonId, "p2");
  finish();
  await flush();
  expect(calls).toEqual([`switch:${b.daemonId}`, `switch:${a.daemonId}`, "open:p2"]);
});

test("a click during an existing connection attempt waits for its live phase", async () => {
  const calls: string[] = [];
  setPhase("resuming");
  publishAllDomains();
  bindNotificationLinks(controller.signal, {
    switchComputer: async daemonId => { calls.push(daemonId); clearNotificationTarget(); },
    refresh: async () => { throw new Error("wrong computer"); },
  });
  capture(b.daemonId);
  await flush();
  expect(calls).toEqual([]);
  setPhase("live");
  publishAllDomains();
  await flush();
  expect(calls).toEqual([b.daemonId]);
});

test("repeated visibility signals do not dispatch a pending link twice", async () => {
  let refreshes = 0;
  bindNotificationLinks(controller.signal, {
    switchComputer: async () => {},
    refresh: async () => { refreshes++; },
  });
  capture(a.daemonId);
  await flush();
  document.dispatchEvent(new happy.Event("visibilitychange"));
  publishAllDomains();
  await flush();
  expect(refreshes).toBe(1);
});

test("binding leaves the already captured cold-start intent to boot", async () => {
  let dispatches = 0;
  capture(a.daemonId);
  bindNotificationLinks(controller.signal, {
    switchComputer: async () => { dispatches++; },
    refresh: async () => { dispatches++; },
  });
  document.dispatchEvent(new happy.Event("visibilitychange"));
  await flush();
  expect(dispatches).toBe(0);
  expect(notificationTarget()?.paneId).toBe("p1");
});

test("a native tap wakes the same notification path as a hash change", async () => {
  const port = nativeFixture();
  const calls: string[] = [];
  bindNotificationLinks(controller.signal, {
    switchComputer: async daemonId => { calls.push(`switch:${daemonId}`); },
    refresh: async () => { calls.push("refresh"); },
  });
  await flush();
  tap(port, `/pair#notify=1&d=${a.daemonId}&pane=p1`);
  await flush();
  expect(calls).toEqual(["refresh"]);
  expect(notificationTarget()?.paneId).toBe("p1");
});

test("a tap that arrived during a cold start is consumed by ready", async () => {
  nativeFixture(`/pair#notify=1&d=${a.daemonId}&pane=p1`);
  const calls: string[] = [];
  bindNotificationLinks(controller.signal, {
    switchComputer: async daemonId => { calls.push(`switch:${daemonId}`); },
    refresh: async () => { calls.push("refresh"); },
  });
  await flush();
  expect(calls).toEqual(["refresh"]);
});

test("malformed native taps are ignored and an aborted page stops listening", async () => {
  const port = nativeFixture();
  let dispatches = 0;
  bindNotificationLinks(controller.signal, {
    switchComputer: async () => { dispatches++; },
    refresh: async () => { dispatches++; },
  });
  await flush();
  tap(port, "https://other.example/pair#notify=1&d=d_aaaaaaaaaaaaaaaaaaaa&pane=p1");
  await flush();
  expect(dispatches).toBe(0);
  expect(notificationTarget()).toBeNull();
  controller.abort();
  tap(port, `/pair#notify=1&d=${a.daemonId}&pane=p1`);
  await flush();
  expect(dispatches).toBe(0);
});
