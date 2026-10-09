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
  setPaneTermMode, composeEnterSends,
  loadPaneTermModes, COMPOSE_ENTER_SENDS_KEY, DEFAULT_COMPOSE_LIVE_KEY, DEFAULT_TERM_MODE_KEY,
} from "../../features/settings/preferences-store";
import { lang, setLangPref, t } from "../../lib/i18n";
import { parseTermMode } from "../../lib/terminal-mode";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../../features/connection/controller";
import type { PairResult } from "../../lib/protocol/client";
import type { LiveSession } from "../../lib/protocol/session-types";

/**
 * Settings entry, computers round trip, back, default mode/input/Return and
 * language against the actual mounted App on a phone viewport. Every default is
 * chosen in place on the overview — segmented controls and a switch — so no
 * choice opens a sheet. Setup writes named domains and the real buttons drive
 * openSettings/openComputers/leave and applyLanguage. The pure
 * preference rules (parseTermMode, pane choice persistence) stay covered by
 * features/settings/preferences-store.test.ts and lib/terminal-mode.test.ts.
 */

const originalFetch = globalThis.fetch;

/** A button by aria-label, exact text, or its settings item label. */
async function click(label: string): Promise<void> {
  const app = appRoot();
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label
      || button.querySelector(".set-item-label")?.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${app.innerHTML.slice(0, 280)}`);
  await act(async () => {
    el.click();
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  });
}

function group(label: string): HTMLElement {
  const found = appRoot().querySelector(`[role="radiogroup"][aria-label="${label}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`missing group ${label}`);
  return found;
}

function options(label: string): Array<{ title: string; current: boolean }> {
  return [...group(label).querySelectorAll<HTMLButtonElement>('button[role="radio"]')].map((el) => ({
    title: el.textContent ?? "",
    current: el.getAttribute("aria-checked") === "true",
  }));
}

async function pick(groupLabel: string, title: string): Promise<void> {
  const el = [...group(groupLabel).querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((button) => button.textContent === title);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${title} in ${groupLabel}`);
  await act(async () => {
    el.click();
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  });
}

function defaultsNote(): string {
  return appRoot().querySelector(".session-defaults .set-foot")?.textContent ?? "";
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
  localStorage.removeItem(COMPOSE_ENTER_SENDS_KEY);
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    resetTransitionState();
    localStorage.removeItem(DEFAULT_TERM_MODE_KEY);
    localStorage.removeItem(DEFAULT_COMPOSE_LIVE_KEY);
    localStorage.removeItem(COMPOSE_ENTER_SENDS_KEY);
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
  // The computer panel leads the overview; the row beneath it switches computers.
  expect(app.querySelector("button.cp-main")).not.toBeNull();
  expect(app.querySelector(".computer-panel .set-nav .set-item-label")?.textContent).toBe("切换电脑");
  expect([...app.querySelectorAll("button")].map((el) => el.textContent)).not.toContain("添加电脑");
  await click("切换电脑");
  expect(currentScreen()).toBe("computers");
  expect(computersFrom()).toBe("settings");
  expect(Boolean(appRoot().querySelector(".computer-add-item"))).toBe(true);
  await click("返回");
  expect(currentScreen()).toBe("settings");
  expect(appRoot().querySelector(".settings-title")?.textContent).toBe("设置");
});

test("on a phone, the Panes tab leaves settings for the list even if a pane is remembered", async () => {
  bootHome();
  await click(t("home.settings"));
  expect(currentScreen()).toBe("settings");
  expect(appRoot().querySelector(".settings-title")?.textContent).toBe("设置");
  await click(t("tabs.panes"));
  expect(currentScreen()).toBe("home");
  expect(appRoot().querySelector(".settings-page")).toBeNull();
  expect(appRoot().querySelector(".host-title")).not.toBeNull();
});

test("settings offers auto and the three explicit views in place, then persists an override", async () => {
  bootHome();
  await click(t("home.settings"));
  expect(appRoot().querySelector(".session-defaults .set-group-label")?.textContent).toBe("窗格默认");
  expect(options("默认模式")).toEqual([
    { title: "自动", current: true }, { title: "控制", current: false },
    { title: "终端", current: false }, { title: "对话", current: false },
  ]);
  expect(defaultsNote()).toContain("自动：按网络和浏览器自动选终端或控制");
  await pick("默认模式", "终端");
  expect(document.querySelector("dialog[open]")).toBeNull();
  expect(paneTermMode("p2")).toBe("full");
  expect(localStorage.getItem(DEFAULT_TERM_MODE_KEY)).toBe("full");
  expect(options("默认模式").find((option) => option.current)?.title).toBe("终端");
  expect(defaultsNote()).toContain("终端：完整终端，需要 WebGL2");
});

test("settings changes only the default input while pane choices remain independent", async () => {
  bootHome();
  act(() => {
    setPaneComposeLive("p1", true);
    setPaneComposeLive("p2", false);
  });
  await click(t("home.settings"));
  expect(options("默认输入方式").find((option) => option.current)?.title).toBe("组字");
  await pick("默认输入方式", "实时");
  expect(options("默认输入方式").find((option) => option.current)?.title).toBe("实时");
  expect(defaultsNote()).toContain("实时：每个字直接进终端");
  expect(localStorage.getItem(DEFAULT_COMPOSE_LIVE_KEY)).toBe("1");
  expect(paneComposeLive("p1")).toBeTrue();
  expect(paneComposeLive("p2")).toBeFalse();
  expect(paneComposeLive("p3")).toBeTrue();
});

test("the Return key switch flips the phone keyboard behavior and says what it does", async () => {
  bootHome();
  await click(t("home.settings"));
  const toggle = appRoot().querySelector<HTMLButtonElement>('.session-defaults [role="switch"]');
  if (!(toggle instanceof HTMLButtonElement)) throw new Error("missing switch");
  expect(document.getElementById(toggle.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("回车键发送");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(defaultsNote()).toContain("回车换行，用发送键发送。");
  await act(async () => { toggle.click(); });
  expect(composeEnterSends()).toBeTrue();
  expect(localStorage.getItem(COMPOSE_ENTER_SENDS_KEY)).toBe("1");
  expect(appRoot().querySelector('.session-defaults [role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  expect(defaultsNote()).toContain("回车直接发送。");
  await act(async () => { appRoot().querySelector<HTMLButtonElement>('.session-defaults [role="switch"]')!.click(); });
  expect(composeEnterSends()).toBeFalse();
});

test("settings can pin english and follow the browser again", async () => {
  bootHome();
  await click(t("home.settings"));
  expect(options("语言").map((option) => option.title)).toEqual(["跟随浏览器", "中文", "English"]);
  await pick("语言", "English");
  expect(lang()).toBe("en");
  expect(appRoot().querySelector(".settings-title")?.textContent).toBe("Settings");
  expect(options("Language").find((option) => option.current)?.title).toBe("English");
  await pick("Language", "Browser default");
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
