import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Node", "DocumentFragment", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { canInterruptAgent, herdLiveness, herdStatus } = await import("./chrome.ts");
const { renderHome } = await import("./home.ts");

type FakeSession = { isConnected: () => boolean };

function setSession(connected: boolean | null): void {
  (state as { live: FakeSession | null }).live = connected === null ? null : { isConnected: () => connected };
}

function leftoverAgent(): void {
  state.agents = [
    { paneId: "pane_1", paneLabel: "build", agent: "codex", status: "done", workspaceLabel: "repo", cwd: "/tmp/repo" },
  ] as unknown as typeof state.agents;
}

afterEach(() => {
  setSession(null);
  state.networkOnline = true;
  state.runtimeKind = "";
  state.herdHost = "";
  state.agents = [];
  state.paneTouched = {};
  state.panePinned = {};
  state.listGroup = "flat";
  app.replaceChildren();
});

describe("herdStatus verdict copy", () => {
  test("phone offline reads as offline, never Herdr-exited", () => {
    state.networkOnline = false;
    setSession(true);
    state.runtimeKind = "herdr";
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("手机没有网络 · 联网后自动恢复");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("dropped transport is reconnecting, not connected and not Herdr-off", () => {
    setSession(false);
    state.runtimeKind = "herdr";
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("连接中断，正在自动重连");
    expect(status.text).not.toContain("已连接");
    expect(status.text).not.toContain("Herdr 没有运行");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("missing session is reconnecting, not connected", () => {
    setSession(null);
    state.runtimeKind = "";
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("连接中断，正在自动重连");
  });

  test("connected session whose GetConfig failed is unverifiable, not connected", () => {
    setSession(true);
    state.runtimeKind = "";
    const status = herdStatus();
    expect(status.tone).toBe("warn");
    expect(status.text).toBe("无法确认 Herdr · 正在重试");
    expect(status.text).not.toBe("已连接");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("only a connected session reporting offline is Herdr-exited", () => {
    setSession(true);
    state.runtimeKind = "offline";
    const status = herdStatus();
    expect(status.tone).toBe("off");
    expect(status.text).toBe("电脑上的 Herdr 没有运行");
    expect(herdLiveness()).toBe("exited");
    // A transport blip with a last-known offline kind must not claim exit.
    setSession(false);
    expect(herdStatus().text).toBe("连接中断，正在自动重连");
    expect(herdLiveness()).toBe("unverifiable");
  });

  test("connected Herdr keeps the connected copy", () => {
    setSession(true);
    state.runtimeKind = "herdr";
    state.herdHost = "desk";
    const status = herdStatus();
    expect(status.tone).toBe("live");
    expect(status.text).toBe("已连接 · desk");
    expect(herdLiveness()).toBe("live");
  });
});

describe("interrupt is gated on live liveness", () => {
  test("a working pane does not offer Stop while disconnected or GetConfig-failed", () => {
    leftoverAgent();
    state.agents[0].status = "working";
    setSession(false);
    state.runtimeKind = "herdr";
    expect(canInterruptAgent("working")).toBe(false);
    setSession(true);
    state.runtimeKind = "";
    expect(canInterruptAgent("working")).toBe(false);
    expect(canInterruptAgent("idle")).toBe(false);
  });

  test("only a live working agent can be interrupted", () => {
    setSession(true);
    state.runtimeKind = "herdr";
    expect(canInterruptAgent("working")).toBe(true);
    expect(canInterruptAgent("idle")).toBe(false);
    expect(canInterruptAgent("blocked")).toBe(false);
  });
});

describe("home list while unverifiable", () => {
  test("disconnected home keeps leftover cards and reads as reconnecting", () => {
    setSession(false);
    state.runtimeKind = "herdr";
    leftoverAgent();
    renderHome();
    const statusline = app.querySelector(".statusline-text");
    expect(statusline?.textContent).toBe("连接中断，正在自动重连");
    expect(statusline?.textContent).not.toContain("已连接");
    expect(statusline?.textContent).not.toContain("Herdr 没有运行");
    // Cards survive the drop; they are dimmed, not wiped.
    const card = app?.querySelector(".card");
    expect(card).not.toBeNull();
    expect(card?.className).toContain("unverifiable");
    expect(card?.textContent).toContain("build");
    expect(app?.querySelector(".empty")).toBeNull();
    // Last-known done never paints as a fresh fact.
    expect(card?.querySelector(".pill-done")).toBeNull();
    expect(card?.querySelector(".pill-unknown")?.textContent).toBe("未知");
    expect(app?.querySelector(".banner-warn")).toBeNull();
  });

  test("live home shows fresh statuses and no stale banner", () => {
    setSession(true);
    state.runtimeKind = "herdr";
    leftoverAgent();
    renderHome();
    const card = app.querySelector(".card");
    expect(card?.className).not.toContain("unverifiable");
    expect(card?.querySelector(".pill-done")?.textContent).toBe("完成");
    expect(app?.querySelector(".banner-warn")).toBeNull();
  });

  test("disconnected home without agents offers the reconnecting empty state, not no-sessions", () => {
    setSession(false);
    state.runtimeKind = "herdr";
    renderHome();
    const empty = app.querySelector(".empty");
    expect(empty?.textContent).toContain("正在重新连接");
    expect(empty?.textContent).not.toContain("还没有会话");
  });
});
