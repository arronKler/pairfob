import { Window } from "happy-dom";
import { afterEach, expect, test } from "bun:test";
import type { LiveSession } from "../lib/protocol/session-types";
import type { AgentQuota } from "../lib/agent-quota";
const happy = new Window({ url: "https://pairfob.com/pair" });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "localStorage", "sessionStorage"] as const) g[key] = (happy as unknown as Record<string, unknown>)[key];
g.location = happy.location;
g.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';
const { app, state } = await import("../state");
const { quotaPanel, refreshAgentQuota, views } = await import("./agent-quota");
const { ProtocolError } = await import("../lib/protocol/errors");
const { setRenderer } = await import("../paint");
const sample = (): AgentQuota => ({ provider: "codex", plan: "pro", status: "ok", source: "app_server", observed_at: Math.floor(Date.now() / 1000), windows: [{ name: "codex", used_percent: 25, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }] });
const session = (read: () => Promise<AgentQuota[]>) => ({ isConnected: () => true, agentQuota: read }) as LiveSession;
afterEach(() => {
  state.live = null;
  state.screen = "home";
  setRenderer(() => {});
  app.replaceChildren();
});
test("renders remaining quota and expired snapshots without a progress bar", async () => {
  state.live = session(async () => [sample()]);
  await refreshAgentQuota();
  expect(quotaPanel().querySelector("progress")?.value).toBe(75);
  state.live = session(async () => [{ ...sample(), observed_at: 1 }]);
  await refreshAgentQuota();
  expect(quotaPanel().querySelector("progress")).toBeNull();
});
test("late reply cannot appear under another computer", async () => {
  let resolve!: (q: AgentQuota[]) => void;
  state.live = session(() => new Promise((r) => { resolve = r; }));
  const pending = refreshAgentQuota();
  state.live = session(async () => []);
  resolve([sample()]);
  await pending;
  expect(quotaPanel().textContent).not.toContain("Codex");
});
test("old daemon gets an upgrade message and refresh cannot duplicate an in-flight read", async () => {
  let calls = 0;
  state.live = session(async () => { calls++; throw new ProtocolError("unknown_op", "old"); });
  await Promise.all([refreshAgentQuota(), refreshAgentQuota()]);
  expect(calls).toBe(1);
  expect(quotaPanel().textContent).toContain("Pairfob");
  expect(quotaPanel().querySelector("progress")).toBeNull();
});

test("unlimited buckets omit progress and unknown reset never renders the epoch", async () => {
  const q = sample();
  state.live = session(async () => [{ ...q, provider: "copilot", source: "github_api", windows: [
    { ...q.windows[0]!, name: "chat", unlimited: true, used_percent: 0, resets_at: 0 },
    { ...q.windows[0]!, name: "premium", resets_at: 0 },
  ] }]);
  await refreshAgentQuota();
  const panel = quotaPanel();
  expect(panel.textContent).toContain("GitHub Copilot");
  expect(panel.querySelectorAll("progress")).toHaveLength(1);
  expect(panel.textContent).not.toContain("1970");
});

test("Grok shows shared subscription allowance", async () => {
  state.live = session(async () => [{ ...sample(), provider: "grok", source: "oauth", plan: "SuperGrok Heavy" }]);
  await refreshAgentQuota();
  const panel = quotaPanel();
  expect(panel.textContent).toContain("Grok Build");
  expect(panel.textContent).toContain("Chat");
  expect(panel.querySelector("progress")?.value).toBe(75);
});

test("settings summary is compact and navigates to a separate details page", async () => {
  const { quotaSummary, quotaOverview } = await import("./agent-quota-summary");
  const { renderQuota } = await import("./agent-quota");
  const q = sample();
  state.live = session(async () => [q]);
  state.screen = "settings";
  await refreshAgentQuota();
  const summary = quotaSummary();
  expect(summary.querySelectorAll(".quota-mini")).toHaveLength(6);
  expect(summary.querySelector(".quota-card")).toBeNull();
  expect(summary.querySelector("progress")).toBeNull();
  expect(summary.querySelector(".quota-ring-center")?.textContent).toBe("75%");
  expect(quotaOverview({ ...q, windows: [...q.windows, { ...q.windows[0]!, used_percent: 90 }] })).toBe(10);
  expect(quotaOverview({ ...q, observed_at: 1 })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "chat" }] })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "premium interactions" }] })).toBe(75);
  expect(summary.querySelector(".set-heading")?.classList.contains("quota-summary-heading")).toBe(true);
  expect(summary.querySelector(".quota-details")).not.toBeNull();
  expect(summary.querySelector(".set-help")).not.toBeNull();
  (summary.querySelector(".quota-mini") as HTMLButtonElement).click();
  expect(state.screen).toBe("quota");
  while (state.live && views.get(state.live)?.loading) await Promise.resolve();
  renderQuota();
  expect(app.querySelector(".settings-page.quota-page")).not.toBeNull();
  expect(app.querySelector(".topbar-title")?.textContent).toBe("订阅余量");
  expect(app.querySelector(".set-title")).toBeNull();
  const refresh = app.querySelector(".topbar .quota-refresh") as HTMLButtonElement | null;
  expect(refresh?.textContent).toBe("刷新余量");
  expect(refresh?.classList.contains("topbar-create")).toBe(true);
  expect(app.textContent).not.toContain("概览环");
  expect(app.querySelector(".quota-card")).not.toBeNull();
  (app.querySelector(".back") as HTMLButtonElement).click();
  expect(state.screen).toBe("settings");
});

test("a failed refresh clears the compact rings instead of retaining a full allowance", async () => {
  const { quotaSummary } = await import("./agent-quota-summary");
  let fail = false;
  state.live = session(async () => { if (fail) throw new Error("offline"); return [sample()]; });
  await refreshAgentQuota();
  expect(quotaSummary().querySelector(".quota-ring-center")?.textContent).toBe("75%");
  fail = true;
  await refreshAgentQuota();
  expect(quotaSummary().querySelectorAll(".is-unknown")).toHaveLength(6);
});
