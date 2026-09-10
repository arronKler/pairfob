import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { batch } from "../../shared/model/domain-store";
import { appHost, type AppHost } from "../../app/host";
import { mountApp, unmountApp } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { attachLiveSession, liveSession, setCredential } from "../../features/computers/catalog-store";
import { setPhase } from "../../features/connection/connection-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { setAgentChat, setFullTerminal } from "../../features/session/session-store";
import { setOperationBusy } from "../../features/operations/capabilities-store";
import { setLang, t } from "../../lib/i18n";
import type { AgentQuota } from "../../lib/agent-quota";
import type { LiveSession } from "../../lib/protocol/session-types";
import { ProtocolError } from "../../lib/protocol/errors";
import { quotaOverview } from "../../features/agent-quota/model";
import { refreshAgentQuota, openQuota } from "../../features/agent-quota/actions";
import { views } from "../../features/agent-quota/store";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../../features/connection/controller";

/**
 * Quota page and settings summary against the actual mounted App: summary ->
 * quota details -> back navigation, session isolation of late replies, no fetch
 * during render, and a refresh that updates the mounted subscription without an
 * extra App commit/request. Teardown restores named values, never the shared
 * store subscriber registries.
 */

const sample = (): AgentQuota => ({
  provider: "codex",
  plan: "pro",
  status: "ok",
  source: "app_server",
  observed_at: Math.floor(Date.now() / 1000),
  windows: [{ name: "codex", used_percent: 25, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 }],
});

/** Attach a fake session through the named action, inside act when mounted. */
function useSession(read: () => Promise<AgentQuota[]>): LiveSession {
  const next = { isConnected: () => true, agentQuota: read } as LiveSession;
  act(() => { attachLiveSession(next); });
  return next;
}

function mountLiveOn(screen: "settings" | "quota"): void {
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen(screen);
      setCredential({
        daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "dev_phone",
        psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
        relayOrigin: "https://pairfob.com", fp: "fp", label: "Phone", createdAt: 1,
      });
    });
    mountApp();
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  registerSessionOwnerPreparer(registerSessionView);
  resetTransitionState();
  setLang("zh");
  // Establish the old fixture's baseline through named actions, not store
  // resets: no session pane, no operation in flight, phone non-terminal view.
  setOperationBusy(false);
  setAgentChat(false);
  setFullTerminal(false);
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    resetTransitionState();
    // Restore named owned values for the next suite, not the shared store
    // subscriber registries.
    attachLiveSession(null);
    setCredential(null);
    setPhase("boot");
    setScreen("home");
    setLang("zh");
    await happy.happyDOM.abort();
  });
});

/** Count host commits/requests on the live host, forwarding via .call and
 *  restoring the original method references in finally (identity preserved). */
function countHost(): {
  commits: () => number;
  requests: () => number;
  finish: () => void;
} {
  const host: AppHost = appHost()!;
  const originalCommit = host.commit;
  const originalRequest = host.requestCommit;
  let commits = 0;
  let requests = 0;
  host.commit = (options => { commits += 1; return originalCommit.call(host, options); });
  host.requestCommit = (() => { requests += 1; return originalRequest.call(host); });
  return {
    commits: () => commits,
    requests: () => requests,
    finish: () => { host.commit = originalCommit; host.requestCommit = originalRequest; },
  };
}

function settle(): Promise<void> {
  return act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
}

test("quota panel does not fetch while rendering", async () => {
  // A connected session is installed before mounting, so the initial render
  // exercises the connected branch; rendering itself still never fetches.
  let calls = 0;
  act(() => {
    setCredential({
      daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "dev_phone",
      psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
      relayOrigin: "https://pairfob.com", fp: "fp", label: "Phone", createdAt: 1,
    });
    attachLiveSession({ isConnected: () => true, agentQuota: async () => { calls += 1; return [sample()]; } } as LiveSession);
    batch(() => { setPhase("live"); setScreen("quota"); });
    mountApp();
  });
  // Mounting the connected panel never triggers a read; the panel is empty.
  expect(calls).toBe(0);
  expect(appRoot().querySelector(".quota-card")).toBeNull();
  // An explicit refresh is the only read.
  await act(async () => { await refreshAgentQuota(); });
  expect(calls).toBe(1);
});

test("a refresh updates the mounted quota page through its subscription with no App commit", async () => {
  mountLiveOn("quota");
  useSession(async () => [sample()]);
  const counter = countHost();
  try {
    const c0 = counter.commits(); const r0 = counter.requests();
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    // Data refresh is subscription-driven; no extra application commit/request.
    expect(counter.commits()).toBe(c0);
    expect(counter.requests()).toBe(r0);
    expect(appRoot().querySelector(".quota-card")).not.toBeNull();
    expect(appRoot().querySelector("progress")?.value).toBe(75);
    expect(appRoot().querySelector(".quota-panel")?.getAttribute("aria-busy")).toBe("false");
  } finally {
    counter.finish();
  }
});

test("late reply cannot appear under another computer", async () => {
  mountLiveOn("quota");
  let resolve!: (q: AgentQuota[]) => void;
  useSession(() => new Promise(r => { resolve = r; }));
  // Start the old read but do not await it while it is in flight.
  let pending: Promise<void>;
  act(() => { pending = refreshAgentQuota(); });
  // The computer switches before the answer lands.
  useSession(async () => []);
  // Resolve the OLD result and await only the same pending read; no extra
  // replacement refresh (a new read could erase the stale data the assertion
  // guards against).
  await act(async () => { resolve([sample()]); await pending; });
  // The late reply landed on the replaced session; the mounted page shows none.
  expect(appRoot().textContent).not.toContain("Codex");
});

test("old daemon gets an upgrade message and refresh cannot duplicate an in-flight read", async () => {
  mountLiveOn("quota");
  let calls = 0;
  useSession(async () => { calls += 1; throw new ProtocolError("unknown_op", "old"); });
  await act(async () => { await Promise.all([refreshAgentQuota(), refreshAgentQuota()]); });
  expect(calls).toBe(1);
  expect(appRoot().textContent).toContain("Pairfob");
  expect(appRoot().querySelector("progress")).toBeNull();
});

test("settings summary is compact, carries the details heading and help, and navigates", async () => {
  mountLiveOn("settings");
  const q = sample();
  useSession(async () => [q]);
  await act(async () => { await refreshAgentQuota(); });
  const app = appRoot();
  expect(app.querySelectorAll(".quota-mini")).toHaveLength(6);
  expect(app.querySelector(".quota-card")).toBeNull();
  expect(app.querySelector("progress")).toBeNull();
  expect(app.querySelector(".quota-ring-center")?.textContent).toBe("75%");
  // Pure model contracts: overview, expired, copilot chat-null vs premium-75.
  expect(quotaOverview({ ...q, windows: [...q.windows, { ...q.windows[0]!, used_percent: 90 }] })).toBe(10);
  expect(quotaOverview({ ...q, observed_at: 1 })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "chat" }] })).toBeNull();
  expect(quotaOverview({ ...q, provider: "copilot", windows: [{ ...q.windows[0]!, name: "premium interactions" }] })).toBe(75);
  // The details control and its help are present inside the quota summary
  // section (the settings page has four other help controls; scope to the
  // summary so removing only the quota help fails this).
  const summary = app.querySelector(".quota-summary");
  expect(summary).not.toBeNull();
  expect(summary!.querySelector(".set-heading.quota-summary-heading")).not.toBeNull();
  expect(summary!.querySelector(".quota-details")).not.toBeNull();
  expect(summary!.querySelector(".set-help")).not.toBeNull();
  // Open the quota details through the real summary control.
  await act(async () => {
    (app.querySelector(".quota-mini") as HTMLButtonElement).click();
    while (views.get(liveSession() as LiveSession)?.loading) await Promise.resolve();
  });
  expect(currentScreen()).toBe("quota");
  expect(appRoot().querySelector(".settings-page.quota-page")).not.toBeNull();
  expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("订阅余量");
  expect(appRoot().querySelector(".set-title")).toBeNull();
  const refresh = appRoot().querySelector(".topbar .quota-refresh") as HTMLButtonElement | null;
  expect(refresh?.textContent).toBe("刷新余量");
  expect(refresh?.classList.contains("topbar-create")).toBe(true);
  expect(appRoot().textContent).not.toContain("概览环");
  expect(appRoot().querySelector(".quota-card")).not.toBeNull();
  // Back returns to settings.
  const back = [...appRoot().querySelectorAll("button")].find(b => b.getAttribute("aria-label") === "返回");
  if (!(back instanceof HTMLButtonElement)) throw new Error("missing back");
  await act(async () => { back.click(); });
  expect(currentScreen()).toBe("settings");
});

test("openQuota composes the arriving quota page through the app commit port", async () => {
  mountLiveOn("settings");
  useSession(async () => [sample()]);
  await act(async () => { await refreshAgentQuota(); });
  await act(async () => { openQuota(); });
  expect(currentScreen()).toBe("quota");
  expect(appRoot().querySelector(".settings-page.quota-page")).not.toBeNull();
  expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("订阅余量");
  expect(appRoot().querySelector(".quota-card")).not.toBeNull();
});

test("a failed refresh clears the compact rings instead of retaining a full allowance", async () => {
  mountLiveOn("settings");
  let fail = false;
  useSession(async () => { if (fail) throw new Error("offline"); return [sample()]; });
  await act(async () => { await refreshAgentQuota(); });
  expect(appRoot().querySelector(".quota-ring-center")?.textContent).toBe("75%");
  fail = true;
  await act(async () => { await refreshAgentQuota(); });
  await settle();
  expect(appRoot().querySelectorAll(".is-unknown")).toHaveLength(6);
});

test("a session attached and refreshed reaches the quota page; a later detach clears it", async () => {
  let calls = 0;
  mountLiveOn("quota");
  // Count App commits/requests from before attach: attach+refresh and the
  // later detach are subscription updates that never drive an App commit.
  const counter = countHost();
  try {
    // Mounting with no session shows the offline copy and does not fetch.
    expect(appRoot().querySelector(".quota-card")).toBeNull();
    expect(appRoot().textContent).toContain("连接电脑后可查看余量。");
    useSession(async () => { calls += 1; return [sample()]; });
    expect(calls).toBe(0);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    expect(calls).toBe(1);
    expect(appRoot().textContent).not.toContain("连接电脑后可查看余量。");
    expect(appRoot().querySelector(".quota-card")).not.toBeNull();
    expect(appRoot().querySelector("progress")?.value).toBe(75);
    // The attach+refresh phase: no extra App commit/request.
    expect(counter.commits()).toBe(0);
    expect(counter.requests()).toBe(0);
    // Detaching the session drops the panel back to the offline copy.
    await act(async () => { attachLiveSession(null); });
    await settle();
    // The detach phase also asks no App commit/request.
    expect(counter.commits()).toBe(0);
    expect(counter.requests()).toBe(0);
    expect(appRoot().querySelector(".quota-card")).toBeNull();
    expect(appRoot().textContent).toContain("连接电脑后可查看余量。");
  } finally {
    counter.finish();
  }
});

test("renders remaining quota and expired snapshots without a progress bar", async () => {
  mountLiveOn("quota");
  useSession(async () => [sample()]);
  await act(async () => { await refreshAgentQuota(); });
  expect(appRoot().querySelector("progress")?.value).toBe(75);
  await act(async () => {
    useSession(async () => [{ ...sample(), observed_at: 1 }]);
    await refreshAgentQuota();
  });
  await settle();
  expect(appRoot().querySelector("progress")).toBeNull();
});

test("quota window names follow the selected language", async () => {
  mountLiveOn("quota");
  useSession(async () => [{
    ...sample(),
    provider: "copilot",
    source: "github_api",
    windows: [
      { ...sample().windows[0]!, name: "chat", unlimited: true, used_percent: 0, resets_at: 0 },
      { ...sample().windows[0]!, name: "premium interactions", window_minutes: 0, resets_at: 0 },
    ],
  }]);
  await act(async () => { await refreshAgentQuota(); });
  await act(async () => { setLang("zh"); });
  expect(appRoot().textContent).toContain("对话");
  expect(appRoot().textContent).toContain("高级对话");
  await act(async () => { setLang("en"); });
  expect(appRoot().textContent).toContain("Chat");
  expect(appRoot().textContent).toContain("Premium interactions");
  await act(async () => { setLang("zh"); });
});

test("unlimited buckets omit progress and unknown reset never renders the epoch", async () => {
  mountLiveOn("quota");
  useSession(async () => [{
    ...sample(),
    provider: "copilot",
    source: "github_api",
    windows: [
      { ...sample().windows[0]!, name: "chat", unlimited: true, used_percent: 0, resets_at: 0 },
      { ...sample().windows[0]!, name: "premium", resets_at: 0 },
    ],
  }]);
  await act(async () => { await refreshAgentQuota(); });
  expect(appRoot().textContent).toContain("GitHub Copilot");
  expect(appRoot().querySelectorAll("progress")).toHaveLength(1);
  expect(appRoot().textContent).not.toContain("1970");
});

test("Grok shows shared subscription allowance", async () => {
  mountLiveOn("quota");
  useSession(async () => [{ ...sample(), provider: "grok", source: "oauth", plan: "SuperGrok Heavy" }]);
  await act(async () => { await refreshAgentQuota(); });
  expect(appRoot().textContent).toContain("Grok Build");
  expect(appRoot().textContent).toContain("Chat");
  expect(appRoot().querySelector("progress")?.value).toBe(75);
});

test("quota refresh keeps focus on the refresh button across a loading repaint", async () => {
  mountLiveOn("quota");
  useSession(async () => [sample()]);
  await act(async () => { await refreshAgentQuota(); });
  const refresh = appRoot().querySelector<HTMLButtonElement>(".quota-refresh");
  if (!(refresh instanceof HTMLButtonElement)) throw new Error("missing refresh");
  act(() => refresh.focus());
  expect(document.activeElement).toBe(refresh);
  // A subscription-driven re-render does not move focus.
  await act(async () => {
    useSession(async () => [{ ...sample(), plan: "pro2" }]);
    await refreshAgentQuota();
  });
  await settle();
  const again = appRoot().querySelector(".quota-refresh");
  expect(again).toBeInstanceOf(HTMLButtonElement);
  expect(document.activeElement).toBe(again);
});

describe("Cursor CLI quota auth states", () => {
  const cursor = (status: AgentQuota["status"]) => ({
    ...sample(), provider: "cursor" as const, plan: "Cursor", status,
  });
  const CMD = "export AGENT_CLI_CREDENTIAL_STORE=file\ncursor-agent login\npairfob service install";

  test("auth_required shows the keychain hint and the exact three-line CLI command", async () => {
    mountLiveOn("quota");
    useSession(async () => [cursor("auth_required")]);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const card = appRoot().querySelector(".quota-card")!;
    // No progress bar, CLI help (not desktop phrasing).
    expect(appRoot().querySelector("progress")).toBeNull();
    expect(card.textContent).toContain("cursor-agent login");
    expect(card.textContent).not.toContain("desktop");
    expect(card.textContent).not.toContain("桌面应用");
    // Help, keychain detail, then the command, then observed.
    expect(card.textContent).toContain(t("quota.cursorHelp"));
    expect(card.textContent).toContain(t("quota.cursorKeychainHelp"));
    const command = appRoot().querySelector(".quota-command")!;
    expect(command.textContent).toBe(CMD);
    expect(card.textContent.indexOf(t("quota.updated", { when: "" }))).toBeGreaterThan(card.textContent.indexOf(CMD));
  });

  test("not_logged_in keeps the CLI login guidance and no command", async () => {
    mountLiveOn("quota");
    useSession(async () => [cursor("not_logged_in")]);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const card = appRoot().querySelector(".quota-card")!;
    expect(appRoot().querySelector("progress")).toBeNull();
    // cursorHelp keeps cursor-agent login; no desktop phrase; no command.
    expect(card.textContent).toContain("cursor-agent login");
    expect(card.textContent).not.toContain("desktop");
    expect(card.textContent).not.toContain("桌面应用");
    expect(card.textContent).toContain(t("quota.cursorHelp"));
    expect(card.textContent).not.toContain("export AGENT_CLI_CREDENTIAL_STORE");
    expect(appRoot().querySelector(".quota-command")).toBeNull();
  });

  test("unsupported shows the dedicated Cursor guidance and no command", async () => {
    mountLiveOn("quota");
    useSession(async () => [cursor("unsupported")]);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const card = appRoot().querySelector(".quota-card")!;
    expect(appRoot().querySelector("progress")).toBeNull();
    // Same literal oracles as the other statuses: CLI login guidance kept, no
    // desktop styling, and dedicated unsupported copy.
    expect(card.textContent).toContain("cursor-agent login");
    expect(card.textContent).not.toContain("desktop");
    expect(card.textContent).not.toContain("桌面应用");
    expect(card.textContent).toContain(t("quota.cursorUnsupportedHelp"));
    expect(card.textContent).not.toContain("export AGENT_CLI_CREDENTIAL_STORE");
    expect(appRoot().querySelector(".quota-command")).toBeNull();
  });
});
