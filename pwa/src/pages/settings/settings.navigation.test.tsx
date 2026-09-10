import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { setPhase, connectionStore, type Phase } from "../../features/connection/connection-store";
import { attachLiveSession, computersStore, setComputers, setCredential, setLastUsedDaemon } from "../../features/computers/catalog-store";
import { currentScreen, computersFrom, navigationStore, setComputersFrom, setScreen, type Screen } from "../../app/navigation-store";
import { openPaneId, selectPane } from "../../features/session/session-store";
import { applySnapshot, captureDashboardProjection } from "../../features/dashboard/catalog-store";
import {
  paneComposeLive, paneTermMode, resetPreferences, setDefaultTermMode, setPaneComposeLive,
  setPaneTermMode,
  loadPaneTermModes, DEFAULT_COMPOSE_LIVE_KEY, DEFAULT_TERM_MODE_KEY,
} from "../../features/settings/preferences-store";
import { lang, setLangPref, t } from "../../lib/i18n";
import { parseTermMode } from "../../lib/terminal-mode";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../../features/connection/controller";
import type { PairResult } from "../../lib/protocol/client";
import type { LiveSession } from "../../lib/protocol/session-types";

/**
 * Settings entry, computers round trip, back, default mode/input and language
 * against the actual mounted App on a phone viewport. Migrated from the former
 * ui/settings.nav facade fixture: setup writes named domains and the real
 * buttons drive openSettings/openComputers/leave and applyLanguage. The pure
 * preference rules (parseTermMode, pane choice persistence) stay covered by
 * features/settings/preferences-store.test.ts and lib/terminal-mode.test.ts.
 */

const originalFetch = globalThis.fetch;

async function click(label: string): Promise<void> {
  const app = appRoot();
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${app.innerHTML.slice(0, 280)}`);
  await act(async () => {
    el.click();
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  });
}

function bootHome(): void {
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("home");
      selectPane("p1");
      applySnapshot({
        workspaces: [{ workspace_id: "w", label: "demo" }],
        panes: [{ pane_id: "p1", workspace_id: "w", agent: "herdr", agent_status: "idle", has_agent: true }],
      });
      attachLiveSession({
        isConnected: () => true,
        listDevices: async () => ({ devices: [] }),
        getConfig: async () => ({ capabilities: {} }),
        agentQuota: async () => [],
      } as never);
    });
    mountApp();
  });
}

/**
 * Foreign preimages of the state this page seeds/mutates (open pane, catalog,
 * credential/live, phase/screen/computersFrom, dashboard), captured before the
 * case runs so afterEach restores the exact pre-case baseline through named
 * owner actions instead of default writes. The removed store.reset calls only
 * dropped subscriber registries. Preferences keep their original named reset
 * (resetPreferences + the two default keys).
 */
const checkpoint = {
  paneId: "",
  credential: null as PairResult | null,
  lastUsed: null as string | null,
  live: null as unknown as LiveSession | null,
  phase: "boot" as Phase,
  screen: "home" as Screen,
  computersFrom: "home" as "home" | "settings",
  computers: [] as readonly PairResult[],
};
let restoreDashboard: (() => void) | null = null;

beforeEach(async () => {
  checkpoint.paneId = openPaneId();
  checkpoint.credential = computersStore.get().credential;
  checkpoint.lastUsed = computersStore.get().lastUsedDaemonId;
  checkpoint.live = computersStore.get().live;
  checkpoint.phase = connectionStore.get().phase;
  checkpoint.screen = navigationStore.get().screen;
  checkpoint.computersFrom = navigationStore.get().computersFrom;
  checkpoint.computers = computersStore.get().computers;
  restoreDashboard = captureDashboardProjection();
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  globalThis.fetch = (async () => new Response("1.1.0")) as typeof fetch;
  registerSessionOwnerPreparer(registerSessionView);
  resetTransitionState();
  setLangPref("zh");
  resetPreferences();
  localStorage.removeItem(DEFAULT_TERM_MODE_KEY);
  localStorage.removeItem(DEFAULT_COMPOSE_LIVE_KEY);
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    resetTransitionState();
    localStorage.removeItem(DEFAULT_TERM_MODE_KEY);
    localStorage.removeItem(DEFAULT_COMPOSE_LIVE_KEY);
    // Restore the actual preference values through the named reset action;
    // the removed store.reset calls only dropped subscriber registries and
    // never the records, so they would leave defaultTermMode/pane choices for
    // the next suite.
    resetPreferences();
    // Restore the captured preimages of the state the page seeds/mutates via
    // named owner actions, retaining external subscriber registries; the
    // dashboard uses its existing named checkpoint.
    selectPane(checkpoint.paneId);
    setComputers(checkpoint.computers);
    setCredential(checkpoint.credential);
    setLastUsedDaemon(checkpoint.lastUsed);
    attachLiveSession(checkpoint.live);
    setPhase(checkpoint.phase);
    setScreen(checkpoint.screen);
    setComputersFrom(checkpoint.computersFrom);
    restoreDashboard?.();
    restoreDashboard = null;
    await happy.happyDOM.abort();
  });
  globalThis.fetch = originalFetch;
  await act(async () => { setLangPref("zh"); });
});

test("one computer row opens the list that both switches and adds, and back returns to settings", async () => {
  bootHome();
  await click(t("home.settings"));
  const app = appRoot();
  expect(app.querySelector("button.set-nav")?.getAttribute("aria-label")).toBe("电脑");
  expect([...app.querySelectorAll("button")].map((el) => el.textContent)).not.toContain("切换电脑");
  expect([...app.querySelectorAll("button")].map((el) => el.textContent)).not.toContain("添加另一台电脑");
  await click("电脑");
  expect(currentScreen()).toBe("computers");
  expect(computersFrom()).toBe("settings");
  expect(Boolean(appRoot().querySelector(".computer-add"))).toBe(true);
  await click("返回");
  expect(currentScreen()).toBe("settings");
  expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("设置");
});

test("on a phone, back from settings returns to the list even if a pane is remembered", async () => {
  bootHome();
  await click(t("home.settings"));
  expect(currentScreen()).toBe("settings");
  expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("设置");
  await click("返回");
  expect(currentScreen()).toBe("home");
  expect(appRoot().querySelector(".settings-page")).toBeNull();
  expect(appRoot().querySelector(".wordmark")?.textContent).toBe("pairfob");
});

test("settings offers auto and the three explicit views, then persists an override", async () => {
  bootHome();
  await click(t("home.settings"));
  const app = appRoot();
  const defaults = [...app.querySelectorAll(".set-heading")].find((row) => row.querySelector(".set-title")?.textContent === "会话默认");
  const card = defaults?.nextElementSibling;
  expect(card?.querySelector('[aria-label="默认模式"]')).toBeTruthy();
  expect(card?.querySelector('[aria-label="终端输入方式"]')).toBeTruthy();
  const group = app.querySelector('[aria-label="默认模式"]');
  expect(Boolean(group)).toBe(true);
  expect([...group!.querySelectorAll("button")].map((el) => el.textContent)).toEqual(["自动", "控制", "终端", "对话"]);
  expect(group!.querySelector('[aria-checked="true"]')?.textContent).toBe("自动");
  await click("终端");
  expect(paneTermMode("p2")).toBe("full");
  expect(localStorage.getItem(DEFAULT_TERM_MODE_KEY)).toBe("full");
  expect(appRoot().querySelector('[aria-label="默认模式"] [aria-checked="true"]')?.textContent).toBe("终端");
});

test("settings changes only the default input while pane choices remain independent", async () => {
  bootHome();
  act(() => {
    setPaneComposeLive("p1", true);
    setPaneComposeLive("p2", false);
  });
  await click(t("home.settings"));
  const app = appRoot();
  const group = app.querySelector('[aria-label="终端输入方式"]');
  expect(group?.querySelector('[aria-checked="true"]')?.textContent).toBe("组字");
  await click("实时");
  expect(localStorage.getItem(DEFAULT_COMPOSE_LIVE_KEY)).toBe("1");
  expect(paneComposeLive("p1")).toBeTrue();
  expect(paneComposeLive("p2")).toBeFalse();
  expect(paneComposeLive("p3")).toBeTrue();
});

test("settings can pin english and follow the browser again", async () => {
  bootHome();
  await click(t("home.settings"));
  const app = appRoot();
  const group = app.querySelector('[aria-label="语言"]');
  expect(Boolean(group)).toBe(true);
  expect([...group!.querySelectorAll("button")].map((el) => el.textContent)).toEqual(["跟随浏览器", "中文", "English"]);
  await click("English");
  expect(lang()).toBe("en");
  expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("Settings");
  expect(appRoot().querySelector('[aria-label="Language"] [aria-checked="true"]')?.textContent).toBe("English");
  await click("Browser default");
  expect(document.documentElement.lang === "en" || document.documentElement.lang === "zh-CN").toBe(true);
  await act(async () => { setLangPref("zh"); });
  expect(t("home.settings")).toBe("设置");
});

// Pure parse/persistence boundary kept from the former navigation fixture: an
// explicit "auto" pane choice round-trips instead of looking absent, and an
// unknown mode never becomes a renderable mode.
test("a per-pane explicit Auto choice survives a storage reload and parseTermMode fails closed", () => {
  expect(parseTermMode("nope")).toBe("auto");
  expect(parseTermMode(null, "full")).toBe("full");
  setPaneTermMode("p1", "auto");
  expect(loadPaneTermModes()).toEqual({ p1: "auto" });
  expect(paneTermMode("p1")).toBe("auto");
});

// Default-vs-pane override transitions, with real typed preference actions:
// changing the default moves every pane without its own choice, and a later
// default change never rewrites a pane that kept an explicit override.
test("a pane without its own choice follows the default; an override keeps it", () => {
  act(() => setDefaultTermMode("full"));
  expect(paneTermMode("p1")).toBe("full");
  act(() => {
    setPaneTermMode("p1", "guided");
    setDefaultTermMode("agent");
  });
  expect(paneTermMode("p1")).toBe("guided");
  expect(paneTermMode("p2")).toBe("agent");
});

// Pure default/pane boundary kept from the former navigation fixture: an
// explicit pane choice overrides the default while a different pane keeps
// falling back to it.
test("a pane switch can override the default input without affecting another pane", () => {
  // Explicit precondition fixed to the false default: an override on p1 is
  // visible while an unchosen pane keeps falling back to false, never compared
  // against a contaminated default.
  act(() => {
    setPaneComposeLive("p9", true);
  });
  expect(paneComposeLive("p9")).toBeTrue();
  expect(paneComposeLive("p8")).toBeFalse();
  setPaneComposeLive("p9", false);
});
