import { resetBoardTestDOM } from "../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { LiveSession } from "../lib/protocol/session-types";
import type { AgentQuota } from "../lib/agent-quota";

const { app, state } = await import("../state");
const { refreshAgentQuota, views } = await import("./agent-quota");
const { ProtocolError } = await import("../lib/protocol/errors");
const { setRenderer } = await import("../paint");
const { renderApp } = await import("./react/app-screen");
const { leaveReactScreen } = await import("./react/root");
const { quotaOverview } = await import("./agent-quota-summary");
const { setLang } = await import("../lib/i18n");

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  state.phase = "live";
  state.screen = "quota";
  state.fullTerminal = false;
  state.agentChat = false;
  state.operationBusy = false;
  setRenderer(renderApp);
});
function panel(): HTMLElement {
  act(renderApp);
  return app.querySelector<HTMLElement>(".quota-panel")!;
}
function summary(): HTMLElement {
  state.screen = "settings";
  act(renderApp);
  return app.querySelector<HTMLElement>(".quota-summary")!;
}
async function refresh(): Promise<void> { await act(refreshAgentQuota); }

const sample = (): AgentQuota => ({ provider: "codex", plan: "pro", status: "ok", source: "app_server", observed_at: Math.floor(Date.now() / 1000), windows: [{ name: "codex", used_percent: 25, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }] });
const session = (read: () => Promise<AgentQuota[]>) => ({ isConnected: () => true, agentQuota: read }) as LiveSession;
afterEach(() => {
  state.live = null;
  state.screen = "home";
  setRenderer(() => {});
  act(leaveReactScreen);
});
test("renders remaining quota and expired snapshots without a progress bar", async () => {
  state.live = session(async () => [sample()]);
  await refresh();
  expect(panel().querySelector("progress")?.value).toBe(75);
  state.live = session(async () => [{ ...sample(), observed_at: 1 }]);
  await refresh();
  expect(panel().querySelector("progress")).toBeNull();
});
test("late reply cannot appear under another computer", async () => {
  let resolve!: (q: AgentQuota[]) => void;
  state.live = session(() => new Promise((r) => { resolve = r; }));
  let pending!: Promise<void>;
  act(() => { pending = refreshAgentQuota(); });
  state.live = session(async () => []);
  await act(async () => { resolve([sample()]); await pending; });
  expect(panel().textContent).not.toContain("Codex");
});
test("old daemon gets an upgrade message and refresh cannot duplicate an in-flight read", async () => {
  let calls = 0;
  state.live = session(async () => { calls++; throw new ProtocolError("unknown_op", "old"); });
  await act(async () => { await Promise.all([refreshAgentQuota(), refreshAgentQuota()]); });
  expect(calls).toBe(1);
  expect(panel().textContent).toContain("Pairfob");
  expect(panel().querySelector("progress")).toBeNull();
});

test("quota window names follow the selected language", async () => {
  const q = sample();
  state.live = session(async () => [{ ...q, provider: "copilot", source: "github_api", windows: [
    { ...q.windows[0]!, name: "chat", unlimited: true, used_percent: 0, resets_at: 0 },
    { ...q.windows[0]!, name: "premium interactions", window_minutes: 0, resets_at: 0 },
  ] }]);
  await refresh();
  setLang("zh");
  expect(panel().textContent).toContain("对话");
  expect(panel().textContent).toContain("高级对话");
  setLang("en");
  expect(panel().textContent).toContain("Chat");
  expect(panel().textContent).toContain("Premium interactions");
  setLang("zh");
});

test("unlimited buckets omit progress and unknown reset never renders the epoch", async () => {
  const q = sample();
  state.live = session(async () => [{ ...q, provider: "copilot", source: "github_api", windows: [
    { ...q.windows[0]!, name: "chat", unlimited: true, used_percent: 0, resets_at: 0 },
    { ...q.windows[0]!, name: "premium", resets_at: 0 },
  ] }]);
  await refresh();
  const section = panel();
  expect(section.textContent).toContain("GitHub Copilot");
  expect(section.querySelectorAll("progress")).toHaveLength(1);
  expect(section.textContent).not.toContain("1970");
});

test("Grok shows shared subscription allowance", async () => {
  state.live = session(async () => [{ ...sample(), provider: "grok", source: "oauth", plan: "SuperGrok Heavy" }]);
  await refresh();
  const section = panel();
  expect(section.textContent).toContain("Grok Build");
  expect(section.textContent).toContain("Chat");
  expect(section.querySelector("progress")?.value).toBe(75);
});

test("settings summary is compact and navigates to a separate details page", async () => {
  const q = sample();
  state.live = session(async () => [q]);
  state.screen = "settings";
  await refresh();
  const section = summary();
  expect(section.querySelectorAll(".quota-mini")).toHaveLength(6);
  expect(section.querySelector(".quota-card")).toBeNull();
  expect(section.querySelector("progress")).toBeNull();
  expect(section.querySelector(".quota-ring-center")?.textContent).toBe("75%");
  expect(quotaOverview({ ...q, windows: [...q.windows, { ...q.windows[0]!, used_percent: 90 }] })).toBe(10);
  expect(quotaOverview({ ...q, observed_at: 1 })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "chat" }] })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "premium interactions" }] })).toBe(75);
  expect(section.querySelector(".set-heading")?.classList.contains("quota-summary-heading")).toBe(true);
  expect(section.querySelector(".quota-details")).not.toBeNull();
  expect(section.querySelector(".set-help")).not.toBeNull();
  act(() => (section.querySelector(".quota-mini") as HTMLButtonElement).click());
  expect(state.screen).toBe("quota");
  await act(async () => { while (state.live && views.get(state.live)?.loading) await Promise.resolve(); });
  act(renderApp);
  expect(app.querySelector(".settings-page.quota-page")).not.toBeNull();
  expect(app.querySelector(".topbar-title")?.textContent).toBe("订阅余量");
  expect(app.querySelector(".set-title")).toBeNull();
  const refreshButton = app.querySelector(".topbar .quota-refresh") as HTMLButtonElement | null;
  expect(refreshButton?.textContent).toBe("刷新余量");
  expect(refreshButton?.classList.contains("topbar-create")).toBe(true);
  expect(app.textContent).not.toContain("概览环");
  expect(app.querySelector(".quota-card")).not.toBeNull();
  act(() => (app.querySelector(".back") as HTMLButtonElement).click());
  expect(state.screen).toBe("settings");
});

test("a failed refresh clears the compact rings instead of retaining a full allowance", async () => {
  let fail = false;
  state.live = session(async () => { if (fail) throw new Error("offline"); return [sample()]; });
  await refresh();
  expect(summary().querySelector(".quota-ring-center")?.textContent).toBe("75%");
  fail = true;
  await refresh();
  expect(summary().querySelectorAll(".is-unknown")).toHaveLength(6);
});
