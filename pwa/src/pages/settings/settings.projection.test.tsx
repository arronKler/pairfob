import { afterEach, beforeEach, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { flushSync } from "react-dom";

/**
 * Settings projection ownership (A2 + R5 regression), real mounted App.
 *
 * - The status row renders from the published connection/runtime snapshots.
 *   While a composition commit is staged (resuming + offline queued), a normal
 *   language notification re-renders the subtree but the row must stay on the
 *   still-published live/demo values — no canonical read a frame early.
 * - A real language change re-renders every simultaneously mounted locale-
 *   dependent composition through the App locale subscription, including the
 *   desktop rail beside the settings column.
 */

const { mountApp, unmountApp } = await import("../../app/mount");
const { appHost, commitView } = await import("../../app/host");
const { getAppFrame } = await import("../../app/frame");
const { appRoot } = await import("../../app/dom-root");
const { registerSessionOwnerPreparer } = await import("../../app/frame");
const { registerSessionView } = await import("../../features/session/register");
const { batch } = await import("../../shared/model/domain-store");
const { connectionStore, setNetworkOnline, setPhase } = await import("../../features/connection/connection-store");
const { setScreen } = await import("../../app/navigation-store");
const { attachLiveSession, setCredential, setComputers } = await import("../../features/computers/catalog-store");
const { applyRuntimeIdentity, resetRuntime } = await import("../../features/connection/runtime-store");
const { applySnapshot, resetDashboard } = await import("../../features/dashboard/catalog-store");
const { setLang, setLangPref, t } = await import("../../lib/i18n");
const { showStatus, clearNotice } = await import("../../app/notices-store");
const { resetTransitionState } = await import("../../app/transition");
const { stopPolling } = await import("../../features/connection/controller");

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  globalThis.fetch = (async () => new Response("2.0.0")) as typeof fetch;
  registerSessionOwnerPreparer(registerSessionView);
  resetTransitionState();
  setLang("en");
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    // Named value/lifecycle cleanup (store.reset would drop external
    // subscribers); the notice, runtime identity and dashboard are reset by
    // their own actions and the boot/home phase restores the default shell.
    clearNotice();
    resetRuntime();
    attachLiveSession(null);
    setCredential(null);
    setComputers([]);
    resetDashboard();
    setNetworkOnline(true);
    setPhase("boot");
    setScreen("home");
    setLang("zh");
    resetTransitionState();
    await happy.happyDOM.abort();
  });
  globalThis.fetch = originalFetch;
});

function mountSettingsLive(): void {
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("settings");
      setCredential({
        daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "dev_phone",
        psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
        relayOrigin: "https://pairfob.com", fp: "fp", label: "Phone", createdAt: 1,
      } as never);
      attachLiveSession({ isConnected: () => true, listDevices: async () => ({ devices: [] }), getConfig: async () => ({ capabilities: {} }), agentQuota: async () => [] } as never);
      applyRuntimeIdentity({ herdHost: "Test Host", runtimeKind: "fake" });
      applySnapshot({
        workspaces: [{ workspace_id: "w", label: "demo" }],
        panes: [{ pane_id: "p1", workspace_id: "w", agent: "herdr", agent_status: "working" }],
      });
    });
    mountApp();
  });
}

test("settings status stays on the published snapshot while the composition commit is held", () => {
  mountSettingsLive();
  const app = appRoot();
  expect(document.body.textContent).toContain(t("chrome.demo"));
  let observed: { publishedOnline: boolean; offline: boolean; demo: boolean } | undefined;
  act(() => {
    setPhase("resuming");
    setNetworkOnline(false);
    // A genuine subscribed language change re-renders the mounted subtree
    // before the queued composition commit.
    flushSync(() => setLang("zh"));
    observed = {
      publishedOnline: connectionStore.get().networkOnline,
      offline: app.textContent?.includes(t("chrome.networkOffline")) ?? false,
      demo: app.textContent?.includes(t("chrome.demo")) ?? false,
    };
    commitView();
  });
  expect(getAppFrame().layout).not.toBeNull();
  expect(observed!.publishedOnline).toBe(true);
  expect(observed!.offline).toBe(false);
  expect(observed!.demo).toBe(true);
  expect(appHost()).not.toBeNull();
});

test("the settings language button updates the simultaneously mounted desktop rail", () => {
  happy.happyDOM.setWindowSize({ width: 1200, height: 900 });
  act(() => setLangPref("zh"));
  mountSettingsLive();
  const app = appRoot();
  const before = app.querySelector(".rail")?.textContent;
  expect(typeof before).toBe("string");
  const english = [...app.querySelectorAll<HTMLButtonElement>("button")]
    .find((el) => el.textContent === "English");
  expect(Boolean(english)).toBeTrue();
  act(() => english!.click());
  expect(app.querySelector(".main .topbar-title")?.textContent).toBe("Settings");
  expect(app.querySelector(".rail")?.textContent === before).toBeFalse();
});

test("mobile settings compose the page chrome with a back bar", () => {
  mountSettingsLive();
  const app = appRoot();
  expect(app.querySelector(".page.settings-page")).not.toBeNull();
  expect(app.querySelector(".topbar-title")?.textContent).toBe("Settings");
  expect([...app.querySelectorAll("button")].some((el) => el.getAttribute("aria-label") === t("chrome.back"))).toBeTrue();
});

test("a domain-driven re-render keeps focus on the network radio", () => {
  mountSettingsLive();
  const app = appRoot();
  const relay = app.querySelector<HTMLButtonElement>(".network-mode-row button[role=radio]:nth-child(3)");
  if (!(relay instanceof HTMLButtonElement) || relay.textContent !== "Relay") {
    throw new Error("missing Relay radio");
  }
  act(() => relay.focus());
  expect(document.activeElement).toBe(relay);
  // An unrelated notice publication re-renders the subscribed settings subtree.
  act(() => {
    showStatus("re-render focus probe", true);
    commitView();
  });
  expect(document.activeElement).toBeInstanceOf(HTMLButtonElement);
  expect((document.activeElement as HTMLButtonElement).textContent).toBe("Relay");
  expect((document.activeElement as HTMLButtonElement).getAttribute("role")).toBe("radio");
  act(() => clearNotice());
});

test("persistent settings notice updates and clears through the mounted subscription", () => {
  // Settings page without a live session: the mounted AppNotice is the notice.
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("settings");
      setCredential(null);
      attachLiveSession(null);
      applyRuntimeIdentity({ herdHost: "", runtimeKind: "fake" });
    });
    mountApp();
  });
  const page = appRoot().firstElementChild;
  act(() => showStatus("review status"));
  expect(appRoot().querySelector("[data-react-notice]")?.textContent).toBe("review status");
  // The notice updates in place; the page root node is not replaced.
  expect(appRoot().firstElementChild).toBe(page);
  act(() => clearNotice());
  expect(appRoot().querySelector("[data-react-notice]")).toBeNull();
});

test("settings renders neutral recovery while the stored runtime still reports live", async () => {
  mountSettingsLive();
  await act(async () => {
    attachLiveSession({ isConnected: () => false, isChecking: () => true } as never);
    applyRuntimeIdentity({ herdHost: "Test Host", runtimeKind: "herdr" });
    commitView();
  });
  expect(appRoot().textContent).toContain(t("chrome.checking"));
  expect(appRoot().querySelector(".dot-pending")).not.toBeNull();
  expect(appRoot().textContent).not.toContain(t("chrome.reconnecting"));
});
