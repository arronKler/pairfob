import { resetTestDOM } from "../../../test-support/boot-dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { AgentQuota } from "../../lib/agent-quota";
import { ProtocolError } from "../../lib/protocol/errors";
import { app, state } from "../../state";
import { setLang } from "../../lib/i18n";
import { quotaOverview } from "../agent-quota-summary";
import { refreshAgentQuota, views } from "../agent-quota";
import { QuotaPanel, QuotaScreen } from "./agent-quota";
import { AgentQuotaSummary } from "./agent-quota-summary";
import { click, installPainter, mount, paintApp, resetRoot, update } from "../../../test-support/settings-render";

beforeEach(resetTestDOM);

const sample = (): AgentQuota => ({
  provider: "codex",
  plan: "pro",
  status: "ok",
  source: "app_server",
  observed_at: Math.floor(Date.now() / 1000),
  windows: [{ name: "codex", used_percent: 25, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }],
});

const session = (read: () => Promise<AgentQuota[]>) => ({ isConnected: () => true, agentQuota: read }) as LiveSession;

afterEach(() => {
  state.live = null;
  state.screen = "home";
  setLang("zh");
  resetRoot();
});

test("renders remaining quota and expired snapshots without a progress bar", async () => {
  state.live = session(async () => [sample()]);
  await refreshAgentQuota();
  mount(createElement(QuotaPanel));
  expect(app.querySelector("progress")?.value).toBe(75);
  state.live = session(async () => [{ ...sample(), observed_at: 1 }]);
  await refreshAgentQuota();
  mount(createElement(QuotaPanel));
  expect(app.querySelector("progress")).toBeNull();
});

test("quota panel does not fetch while rendering", async () => {
  let calls = 0;
  state.live = session(async () => {
    calls += 1;
    return [sample()];
  });
  mount(createElement(QuotaPanel));
  expect(calls).toBe(0);
  expect(app.querySelector(".quota-card")).toBeNull();
});

test("late reply cannot appear under another computer", async () => {
  let resolve!: (q: AgentQuota[]) => void;
  state.live = session(() => new Promise((r) => { resolve = r; }));
  const pending = refreshAgentQuota();
  state.live = session(async () => []);
  resolve([sample()]);
  await pending;
  mount(createElement(QuotaPanel));
  expect(app.textContent).not.toContain("Codex");
});

test("old daemon gets an upgrade message and refresh cannot duplicate an in-flight read", async () => {
  let calls = 0;
  state.live = session(async () => {
    calls += 1;
    throw new ProtocolError("unknown_op", "old");
  });
  await Promise.all([refreshAgentQuota(), refreshAgentQuota()]);
  mount(createElement(QuotaPanel));
  expect(calls).toBe(1);
  expect(app.textContent).toContain("Pairfob");
  expect(app.querySelector("progress")).toBeNull();
});

test("quota window names follow the selected language", async () => {
  const q = sample();
  state.live = session(async () => [{
    ...q,
    provider: "copilot",
    source: "github_api",
    windows: [
      { ...q.windows[0]!, name: "chat", unlimited: true, used_percent: 0, resets_at: 0 },
      { ...q.windows[0]!, name: "premium interactions", window_minutes: 0, resets_at: 0 },
    ],
  }]);
  await refreshAgentQuota();
  setLang("zh");
  mount(createElement(QuotaPanel));
  expect(app.textContent).toContain("对话");
  expect(app.textContent).toContain("高级对话");
  setLang("en");
  mount(createElement(QuotaPanel));
  expect(app.textContent).toContain("Chat");
  expect(app.textContent).toContain("Premium interactions");
  setLang("zh");
});

test("unlimited buckets omit progress and unknown reset never renders the epoch", async () => {
  const q = sample();
  state.live = session(async () => [{
    ...q,
    provider: "copilot",
    source: "github_api",
    windows: [
      { ...q.windows[0]!, name: "chat", unlimited: true, used_percent: 0, resets_at: 0 },
      { ...q.windows[0]!, name: "premium", resets_at: 0 },
    ],
  }]);
  await refreshAgentQuota();
  mount(createElement(QuotaPanel));
  expect(app.textContent).toContain("GitHub Copilot");
  expect(app.querySelectorAll("progress")).toHaveLength(1);
  expect(app.textContent).not.toContain("1970");
});

test("Grok shows shared subscription allowance", async () => {
  state.live = session(async () => [{ ...sample(), provider: "grok", source: "oauth", plan: "SuperGrok Heavy" }]);
  await refreshAgentQuota();
  mount(createElement(QuotaPanel));
  expect(app.textContent).toContain("Grok Build");
  expect(app.textContent).toContain("Chat");
  expect(app.querySelector("progress")?.value).toBe(75);
});

test("settings summary is compact and navigates to a separate details page", async () => {
  const q = sample();
  state.live = session(async () => [q]);
  state.screen = "settings";
  await refreshAgentQuota();
  mount(createElement(AgentQuotaSummary));
  expect(app.querySelectorAll(".quota-mini")).toHaveLength(6);
  expect(app.querySelector(".quota-card")).toBeNull();
  expect(app.querySelector("progress")).toBeNull();
  expect(app.querySelector(".quota-ring-center")?.textContent).toBe("75%");
  expect(quotaOverview({ ...q, windows: [...q.windows, { ...q.windows[0]!, used_percent: 90 }] })).toBe(10);
  expect(quotaOverview({ ...q, observed_at: 1 })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "chat" }] })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "premium interactions" }] })).toBe(75);
  expect(app.querySelector(".set-heading")?.classList.contains("quota-summary-heading")).toBe(true);
  expect(app.querySelector(".quota-details")).not.toBeNull();
  expect(app.querySelector(".set-help")).not.toBeNull();
  installPainter();
  state.screen = "settings";
  (app.querySelector(".quota-mini") as HTMLButtonElement).click();
  expect(state.screen).toBe("quota");
  while (state.live && views.get(state.live)?.loading) await Promise.resolve();
  paintApp();
  expect(app.querySelector(".settings-page.quota-page")).not.toBeNull();
  expect(app.querySelector(".topbar-title")?.textContent).toBe("订阅余量");
  expect(app.querySelector(".set-title")).toBeNull();
  const refresh = app.querySelector(".topbar .quota-refresh") as HTMLButtonElement | null;
  expect(refresh?.textContent).toBe("刷新余量");
  expect(refresh?.classList.contains("topbar-create")).toBe(true);
  expect(app.textContent).not.toContain("概览环");
  expect(app.querySelector(".quota-card")).not.toBeNull();
  click("返回");
  expect(state.screen).toBe("settings");
});

test("a failed refresh clears the compact rings instead of retaining a full allowance", async () => {
  let fail = false;
  state.live = session(async () => {
    if (fail) throw new Error("offline");
    return [sample()];
  });
  await refreshAgentQuota();
  mount(createElement(AgentQuotaSummary));
  expect(app.querySelector(".quota-ring-center")?.textContent).toBe("75%");
  fail = true;
  await refreshAgentQuota();
  mount(createElement(AgentQuotaSummary));
  expect(app.querySelectorAll(".is-unknown")).toHaveLength(6);
});

test("quota refresh keeps focus across a loading repaint", async () => {
  state.live = session(async () => [sample()]);
  state.screen = "quota";
  await refreshAgentQuota();
  installPainter();
  mount(createElement(QuotaScreen));
  const refresh = app.querySelector(".quota-refresh");
  if (!(refresh instanceof HTMLButtonElement)) throw new Error("missing refresh");
  refresh.focus();
  expect(document.activeElement).toBe(refresh);
  update(createElement(QuotaScreen));
  const again = app.querySelector(".quota-refresh");
  expect(again).toBeInstanceOf(HTMLButtonElement);
  expect(document.activeElement).toBe(again);
});
