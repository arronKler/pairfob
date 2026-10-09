import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "./dom-root";
import { commitTest, mountTestApp, unmountTestApp } from "../../test-support/react-harness";
import { canInterruptAgent, herdLiveness, herdStatus } from "../features/connection/runtime-status";
import { attachLiveSession } from "../features/computers/catalog-store";
import { setNetworkOnline, setPhase } from "../features/connection/connection-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../features/dashboard/catalog-store";
import { setScreen } from "./navigation-store";
import { applyCapabilities, setOperationBusy } from "../features/operations/capabilities-store";
import { applyRuntimeIdentity, resetRuntime } from "../features/connection/runtime-store";
import { resetHerdPresentationChoices } from "../features/settings/preferences-store";
import { resetHerdAttention } from "../lib/herd-attention";
import { setLang, t } from "../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../lib/operations";
import type { LiveSession } from "../lib/protocol/session-types";

type FakeSession = { isConnected: () => boolean };

/** The runtime-status adapter reads canonical live reads; drive it via owner actions. */
function setSession(connected: boolean | null): void {
  attachLiveSession(connected === null ? null : ({ isConnected: () => connected } as FakeSession) as unknown as LiveSession);
}

/** One leftover card (dashboard owner action) the disconnected home must retain. */
function leftoverAgent(): void {
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "repo", cwd: "/tmp/repo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "pane_1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex",
      agent_status: "done", label: "build", cwd: "/tmp/repo" }],
  });
}

function renderHome(): void {
  mountTestApp();
  commitTest();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  setLang("zh");
  setPhase("live");
  setScreen("home");
  resetDashboard();
  resetHerdPresentationChoices();
  resetHerdAttention();
  resetRuntime();
  setOperationBusy(false);
  setNetworkOnline(true);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  attachLiveSession(null);
});

afterEach(() => {
  act(() => unmountTestApp());
  setSession(null);
  setNetworkOnline(true);
  applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
  setOperationBusy(false);
  resetDashboard();
  resetHerdPresentationChoices();
  resetHerdAttention();
  appRoot().replaceChildren();
});

describe("herdStatus verdict copy", () => {
  test("phone offline reads as offline, never Herdr-exited", () => {
    setNetworkOnline(false);
    setSession(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("当前没有网络 · 联网后自动恢复");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("dropped transport is reconnecting, not connected and not Herdr-off", () => {
    setSession(false);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("连接中断，正在自动重连");
    expect(status.text).not.toContain("已连接");
    expect(status.text).not.toContain("Herdr 不可用");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("missing session is reconnecting, not connected", () => {
    setSession(null);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("连接中断，正在自动重连");
  });

  test("connected session whose GetConfig failed is unverifiable, not connected", () => {
    setSession(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("无法确认 Herdr · 正在重试");
    expect(status.text).not.toBe("已连接");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("only a connected session reporting offline is Herdr-exited", () => {
    setSession(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "offline" });
    const status = herdStatus();
    expect(status.tone).toBe("off");
    expect(status.text).toBe("电脑上的 Herdr 不可用");
    expect(herdLiveness()).toBe("exited");
    // A transport blip with a last-known offline kind must not claim exit.
    setSession(false);
    expect(herdStatus().text).toBe("连接中断，正在自动重连");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("connected Herdr keeps the connected copy", () => {
    setSession(true);
    applyRuntimeIdentity({ herdHost: "desk", runtimeKind: "herdr" });
    const status = herdStatus();
    expect(status.tone).toBe("live");
    expect(status.text).toBe("已连接 · desk");
    expect(herdLiveness()).toBe("live");
  });
});

describe("interrupt is gated on live liveness", () => {
  test("a working pane does not offer Stop while disconnected or GetConfig-failed", () => {
    leftoverAgent();
    act(() => replaceAgentsFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "repo", cwd: "/tmp/repo" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "pane_1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex",
        agent_status: "working", label: "build", cwd: "/tmp/repo" }],
    }));
    setSession(false);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    expect(canInterruptAgent("working")).toBe(false);
    setSession(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
    expect(canInterruptAgent("working")).toBe(false);
    expect(canInterruptAgent("idle")).toBe(false);
  });

  test("only a live working agent can be interrupted", () => {
    setSession(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    expect(canInterruptAgent("working")).toBe(true);
    expect(canInterruptAgent("idle")).toBe(false);
    expect(canInterruptAgent("blocked")).toBe(false);
  });
});

describe("home list while unverifiable", () => {
  test("disconnected home keeps leftover cards and reads as reconnecting", () => {
    setSession(false);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    leftoverAgent();
    renderHome();
    const app = appRoot();
    // The phone header's connection line carries the status sentence.
    const statusline = app.querySelector(".host-title-line");
    expect(statusline?.textContent).toBe("连接中断，正在自动重连");
    expect(statusline?.textContent).not.toContain("已连接");
    expect(statusline?.textContent).not.toContain("Herdr 不可用");
    expect(app.querySelector(".host-title.is-warn")).not.toBeNull();
    // Cards survive the drop; they are dimmed, not wiped.
    const card = app?.querySelector(".card");
    expect((card) !== null).toBe(true);
    expect(card?.className).toContain("unverifiable");
    expect(card?.textContent).toContain("build");
    expect((app?.querySelector(".empty")) === null).toBe(true);
    // Last-known done never paints as a fresh fact.
    expect((card?.querySelector(".card-status.is-done")) === null).toBe(true);
    expect(card?.className).not.toContain("is-unread");
    expect(card?.querySelector(".card-status.is-unknown")?.textContent).toBe("未知");
    expect((app?.querySelector(".banner-warn")) === null).toBe(true);
  });

  test("connected but unverifiable home offers a retry in the header line", () => {
    setSession(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
    leftoverAgent();
    renderHome();
    // The status the reader already looks at also says what a tap does.
    expect(appRoot().querySelector(".host-title-line")?.textContent).toBe(t("host.unverifiedLine"));
  });

  test("live home shows fresh statuses and no stale banner", () => {
    setSession(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    leftoverAgent();
    renderHome();
    const app = appRoot();
    const card = app.querySelector(".card");
    expect(card?.className).not.toContain("unverifiable");
    expect(card?.querySelector(".card-status.is-done")?.textContent).toBe(t("status.done"));
    expect((app.querySelector(".banner-warn")) === null).toBe(true);
  });

  test("disconnected home without agents notes the reconnect, not no-sessions", () => {
    setSession(false);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    renderHome();
    // The header carries the status; the list only says what happens next.
    expect(appRoot().querySelector(".herd-empty-note")?.textContent).toBe(t("empty.reconnectNote"));
    expect(appRoot().querySelector(".herd-empty-title")).toBeNull();
    expect(appRoot().querySelector(".herd-empty-action")).toBeNull();
  });
});
