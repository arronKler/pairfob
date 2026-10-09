import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { startApplication, stopApplication } from "./bootstrap";
import { commitApp } from "./commit";
import { currentScreen, setScreen } from "./navigation-store";
import { clearNotice, visibleNotice } from "./notices-store";
import { attachLiveSession, setComputers, setCredential } from "../features/computers/catalog-store";
import { clearNotificationTarget, notificationTarget, setNetworkOnline, setPhase } from "../features/connection/connection-store";
import { stopPolling } from "../features/connection/controller";
import { resetDashboard } from "../features/dashboard/catalog-store";
import { openPaneId, selectPane } from "../features/session/session-store";
import { defaultTermMode, setDefaultTermMode } from "../features/settings/preferences-store";
import { lang, setLang, t } from "../lib/i18n";
import type { LiveSession, PairResult } from "../lib/protocol/client";

const pair = { daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "device", label: "test",
  relayOrigin: "https://pairfob.com", createdAt: 1, fp: "fp",
  psk: new Uint8Array(32), daemonPk: new Uint8Array(32) } as PairResult;
const target = (pane = "p1") => `/pair#notify=1&d=${pair.daemonId}&pane=${pane}`;
const originalFetch = globalThis.fetch;
let reads: string[];
let worker: EventTarget;
let workerDescriptor: PropertyDescriptor | undefined;
let onlineDescriptor: PropertyDescriptor | undefined;
let previousLang: ReturnType<typeof lang>;
let previousMode: ReturnType<typeof defaultTermMode>;

async function settle(work?: () => void) {
  await act(async () => {
    work?.();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  previousLang = lang();
  previousMode = defaultTermMode();
  onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  history.replaceState(null, "", "/pair");
  workerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  worker = new happy.EventTarget() as unknown as EventTarget;
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  globalThis.fetch = (async () => Response.json({ protocol: 2, p2p: false })) as typeof fetch;
  // Let real boot settle on its storage hold, then install an established
  // session at the transport boundary. Page listeners remain the real ones.
  await settle(() => startApplication());
  reads = [];
  await settle(() => {
    setLang("en");
    clearNotice();
    setComputers([pair]);
    setCredential(pair);
    attachLiveSession({ isConnected: () => true,
      setNetworkAvailable: () => {},
      reconnectNow: () => {},
      // This fixture observes panes only. A foreground config read is allowed
      // to fail; it must not start the unrelated global release-check cache.
      getConfig: async () => { throw new Error("fixture has no runtime config"); },
      snapshot: async () => ({ panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1" }] }),
      paneRead: async (paneId: string) => { reads.push(paneId); return { text: "notification pane", hash: "1".repeat(64) }; },
    } as unknown as LiveSession);
    setDefaultTermMode("guided");
    setNetworkOnline(true);
    setPhase("live");
    setScreen("settings");
    commitApp();
  });
});

afterEach(async () => {
  await settle(() => {
    stopApplication();
    stopPolling();
    attachLiveSession(null);
    setCredential(null);
    setComputers([]);
    clearNotificationTarget();
    clearNotice();
    resetDashboard();
    selectPane("");
    setPhase("boot");
    setScreen("home");
    setLang(previousLang);
    setDefaultTermMode(previousMode);
  });
  history.replaceState(null, "", "/pair");
  globalThis.fetch = originalFetch;
  if (workerDescriptor) Object.defineProperty(navigator, "serviceWorker", workerDescriptor);
  else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  if (onlineDescriptor) Object.defineProperty(navigator, "onLine", onlineDescriptor);
  else delete (navigator as unknown as Record<string, unknown>).onLine;
});

test("notification navigation into an already running app opens its pane", async () => {
  await settle(() => { location.hash = target().split("#")[1]!; });
  expect(currentScreen()).toBe("pane");
  expect(openPaneId()).toBe("p1");
  expect(reads).toContain("p1");
  expect(location.hash).toBe("");
  expect(notificationTarget()).toBeNull();
});

test("a running app reports a notification pane that disappeared", async () => {
  await settle(() => { location.hash = target("gone").split("#")[1]!; });
  expect(currentScreen()).toBe("home");
  expect(visibleNotice()?.text).toBe(t("err.notifyGone"));
});

function message(url: string): void {
  worker.dispatchEvent(new happy.MessageEvent("message", {
    data: { type: "pairfob_notify", url },
  }) as unknown as Event);
}

test("worker messages open a pane without navigating the page", async () => {
  await settle(() => message(target()));
  expect(currentScreen()).toBe("pane");
  expect(openPaneId()).toBe("p1");
  expect(location.hash).toBe("");
});

test("a background click waits for visibility and then reads the fresh snapshot", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await settle(() => message(target()));
  expect(currentScreen()).toBe("settings");
  expect(notificationTarget()?.paneId).toBe("p1");
  expect(reads).toEqual([]);
  await settle(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new happy.Event("visibilitychange"));
  });
  expect(currentScreen()).toBe("pane");
  expect(openPaneId()).toBe("p1");
});

test("invalid worker links cannot overwrite a valid pending click", async () => {
  await settle(() => {
    setNetworkOnline(false);
    message(target());
    message(`https://evil.example${target("gone")}`);
    message(target("gone").replace("/pair#", "/pair?bad=1#"));
  });
  expect(notificationTarget()?.paneId).toBe("p1");
  await settle(() => setNetworkOnline(true));
  expect(openPaneId()).toBe("p1");
});

test("unknown computers show a notice without changing the active computer", async () => {
  await settle(() => message(target().replace(pair.daemonId, "d_bbbbbbbbbbbbbbbbbbbb")));
  expect(visibleNotice()?.text).toBe(t("err.notifyComputerGone"));
  expect(notificationTarget()).toBeNull();
  expect(reads).toEqual([]);
});

test("stopping the app releases both notification listeners", async () => {
  await settle(() => stopApplication());
  await settle(() => {
    message(target());
    location.hash = target().split("#")[1]!;
  });
  expect(notificationTarget()).toBeNull();
  expect(reads).toEqual([]);
});
