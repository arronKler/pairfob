import { expectDifferentNode, expectSameNode } from "../../../test-support/node-identity";
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
import { quotaAccount, quotaOff, quotaReport, quotaShare } from "../../../test-support/quota";
import type { QuotaAccount } from "../../lib/agent-quota-v2";
import type { QuotaReport } from "../../lib/agent-quota-report";
import type { LiveSession } from "../../lib/protocol/session-types";
import { ProtocolError } from "../../lib/protocol/errors";
import { quotaResetIn } from "../../features/agent-quota/model";
import { loadQuotaCache, resetQuotaCache, saveQuotaCache } from "../../lib/quota-cache";
import { CREATE_MEMORY_KEY } from "../../features/operations/create-memory";
import { refreshAgentQuota, openQuota } from "../../features/agent-quota/actions";
import { views } from "../../features/agent-quota/store";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../../features/connection/controller";

/**
 * Quota page and the settings quota module against the actual mounted App: module ->
 * quota details -> back navigation, session isolation of late replies, no fetch
 * during render, and a refresh that updates the mounted subscription without an
 * extra App commit/request. Teardown restores named values, never the shared
 * store subscriber registries.
 */

const sample = (): QuotaAccount => quotaAccount();

/** Attach a fake session through the named action, inside act when mounted. Its read answers accounts. */
function useSession(read: () => Promise<QuotaAccount[]>, report: Omit<QuotaReport, "accounts"> = { legacy: false, unknown: 0 }): LiveSession {
  const next = { isConnected: () => true, agentQuota: async () => ({ accounts: await read(), ...report }) } as LiveSession;
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
  // A saved answer from one case must not paint in the next.
  resetQuotaCache();
  await (await import("../../app/connected-loader")).loadConnectedRuntime();
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

/** The remaining share a meter reports, or null when no meter is drawn. */
function meterValue(): number | null {
  const meter = appRoot().querySelector(".quota-meter[aria-valuenow]");
  return meter ? Number(meter.getAttribute("aria-valuenow")) : null;
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
    attachLiveSession({ isConnected: () => true, agentQuota: async () => { calls += 1; return quotaReport(sample()); } } as LiveSession);
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

test("the last saved answer paints while a slow read is still running", async () => {
  saveQuotaCache("d_aaaaaaaaaaaaaaaaaaaa", { items: [sample()], legacy: false, unknown: 0 });
  mountLiveOn("quota");
  let finish!: (accounts: QuotaAccount[]) => void;
  useSession(() => new Promise<QuotaAccount[]>(resolve => { finish = resolve; }));
  let pending!: Promise<unknown>;
  act(() => { pending = refreshAgentQuota(); });
  await settle();
  // The balances are on screen from the first frame, with the read still out.
  expect(appRoot().querySelector("#quota-codex.quota-card")).not.toBeNull();
  expect(meterValue()).toBe(75);
  expect(appRoot().querySelector(".quota-panel")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => { finish([sample()]); await pending; });
});

test("a refresh keeps the answer for the next app start, and a failure leaves it in place", async () => {
  mountLiveOn("quota");
  // One sample for the whole case: its observed_at comes from the clock, so a
  // second call could land in the next second and compare two different reads.
  const account = sample();
  let fail = false;
  useSession(async () => { if (fail) throw new Error("offline"); return [account]; });
  await act(async () => { await refreshAgentQuota(); });
  expect(loadQuotaCache("d_aaaaaaaaaaaaaaaaaaaa")?.items).toEqual([account]);
  fail = true;
  await act(async () => { await refreshAgentQuota(); });
  await settle();
  expect(loadQuotaCache("d_aaaaaaaaaaaaaaaaaaaa")?.items).toEqual([account]);
  expect(appRoot().querySelector("#quota-codex.quota-card")).not.toBeNull();
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
    expect(meterValue()).toBe(75);
    expect(appRoot().querySelector(".quota-panel")?.getAttribute("aria-busy")).toBe("false");
  } finally {
    counter.finish();
  }
});

test("late reply cannot appear under another computer", async () => {
  mountLiveOn("quota");
  let resolve!: (q: QuotaAccount[]) => void;
  useSession(() => new Promise(r => { resolve = r; }));
  // Start the old read but do not await it while it is in flight.
  let pending: Promise<unknown>;
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

test("a late reply is not kept under the computer that replaced it", async () => {
  mountLiveOn("quota");
  let resolve!: (accounts: QuotaAccount[]) => void;
  useSession(() => new Promise<QuotaAccount[]>(r => { resolve = r; }));
  let pending!: Promise<unknown>;
  act(() => { pending = refreshAgentQuota(); });
  act(() => {
    setCredential({
      daemonId: "d_bbbbbbbbbbbbbbbbbbbb", deviceId: "dev_phone",
      psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
      relayOrigin: "https://pairfob.com", fp: "fp", label: "Phone", createdAt: 1,
    });
    attachLiveSession({ isConnected: () => true, agentQuota: async () => quotaReport(sample()) } as LiveSession);
  });
  await act(async () => { resolve([sample()]); await pending; });
  expect(loadQuotaCache("d_bbbbbbbbbbbbbbbbbbbb")).toBeNull();
});

test("old daemon gets an upgrade message and refresh cannot duplicate an in-flight read", async () => {
  mountLiveOn("quota");
  let calls = 0;
  useSession(async () => { calls += 1; throw new ProtocolError("unknown_op", "old"); });
  await act(async () => { await Promise.all([refreshAgentQuota(), refreshAgentQuota()]); });
  expect(calls).toBe(1);
  expect(appRoot().textContent).toContain("Pairfob");
  expect(meterValue()).toBeNull();
});

test("the settings module shows one meter row per account with numbers and opens that account's card", async () => {
  mountLiveOn("settings");
  const q = sample();
  useSession(async () => [q]);
  await act(async () => { await refreshAgentQuota(); });
  const app = appRoot();
  const module = app.querySelector(".quota-module");
  expect(module?.querySelector(".set-group-label")?.textContent).toContain("订阅余量");
  expect(module?.querySelector(".set-help")).toBeNull();
  const rows = [...app.querySelectorAll<HTMLButtonElement>(".quota-row")];
  expect(rows.map((row) => row.querySelector(".set-item-label")?.textContent)).toEqual(["Codex"]);
  expect(rows[0]!.querySelector(".set-item-sub")?.textContent).toBe(`5 小时 · ${quotaResetIn(q.meters[0]!.resets_at)}`);
  expect(meterValue()).toBe(75);
  expect(app.querySelector(".quota-card")).toBeNull();
  // The last row counts the accounts instead of listing what this computer never used.
  expect(app.querySelector(".quota-all .set-val")?.textContent).toBe("共 1 个");
  await act(async () => {
    rows[0]!.click();
    while (views.get(liveSession() as LiveSession)?.loading) await Promise.resolve();
  });
  expect(currentScreen()).toBe("quota");
  expect(appRoot().querySelector(".settings-page.quota-page")).not.toBeNull();
  expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("订阅余量");
  const refresh = appRoot().querySelector(".topbar .quota-refresh") as HTMLButtonElement | null;
  expect(refresh?.textContent).toBe("刷新余量");
  expect(refresh?.classList.contains("topbar-create")).toBe(true);
  expect(appRoot().querySelector("#quota-codex.quota-card")).not.toBeNull();
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

test("a failed refresh keeps the numbers that were read, and a first read that fails shows none", async () => {
  mountLiveOn("settings");
  let fail = true;
  useSession(async () => { if (fail) throw new Error("offline"); return [sample()]; });
  await act(async () => { await refreshAgentQuota(); });
  // Nothing was ever read: one line, never a full or an empty meter.
  expect(appRoot().querySelector(".quota-row")).toBeNull();
  expect(appRoot().querySelector(".quota-module")?.textContent).toContain(t("quota.failed"));
  fail = false;
  await act(async () => { await refreshAgentQuota(); });
  expect(meterValue()).toBe(75);
  fail = true;
  await act(async () => { await refreshAgentQuota(); });
  await settle();
  expect(meterValue()).toBe(75);
  await act(async () => { openQuota(); });
  await settle();
  // The page says the read failed above the cards it still has.
  expect(appRoot().querySelector(".quota-lede.is-error")?.textContent).toBe(t("quota.kept"));
  expect(appRoot().querySelector("#quota-codex.quota-card")).not.toBeNull();
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
    expect(meterValue()).toBe(75);
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

test("renders remaining quota and expired snapshots without a meter", async () => {
  mountLiveOn("quota");
  useSession(async () => [sample()]);
  await act(async () => { await refreshAgentQuota(); });
  expect(meterValue()).toBe(75);
  await act(async () => {
    useSession(async () => [{ ...sample(), observed_at: 1 }]);
    await refreshAgentQuota();
  });
  await settle();
  expect(meterValue()).toBeNull();
});

test("quota window names follow the selected language", async () => {
  mountLiveOn("quota");
  useSession(async () => [quotaAccount({
    provider: "copilot",
    meters: [
      { kind: "unlimited", name: "chat", pool: "chat", headline: false, window_minutes: 0, resets_at: 0 },
      quotaShare({ name: "premium interactions", pool: "premium-interactions", window_minutes: 0, resets_at: 0 }),
    ],
  })]);
  await act(async () => { await refreshAgentQuota(); });
  await act(async () => { setLang("zh"); });
  expect(appRoot().textContent).toContain("对话");
  expect(appRoot().textContent).toContain("高级对话");
  await act(async () => { setLang("en"); });
  expect(appRoot().textContent).toContain("Chat");
  expect(appRoot().textContent).toContain("Premium interactions");
  await act(async () => { setLang("zh"); });
});

test("unlimited buckets draw an unlimited meter and unknown reset never renders the epoch", async () => {
  mountLiveOn("quota");
  useSession(async () => [quotaAccount({
    provider: "copilot",
    meters: [
      { kind: "unlimited", name: "chat", pool: "chat", headline: false, window_minutes: 0, resets_at: 0 },
      quotaShare({ name: "premium", resets_at: 0 }),
    ],
  })]);
  await act(async () => { await refreshAgentQuota(); });
  expect(appRoot().textContent).toContain("GitHub Copilot");
  expect(appRoot().querySelectorAll(".quota-meter[aria-valuenow]")).toHaveLength(1);
  expect(appRoot().querySelectorAll(".quota-meter.is-unlimited")).toHaveLength(1);
  expect(appRoot().textContent).not.toContain("1970");
});

test("Grok shows shared subscription allowance", async () => {
  mountLiveOn("quota");
  useSession(async () => [quotaAccount({ provider: "grok", plan: "SuperGrok Heavy" })]);
  await act(async () => { await refreshAgentQuota(); });
  expect(appRoot().textContent).toContain("Grok Build");
  expect(appRoot().textContent).toContain("Chat");
  expect(meterValue()).toBe(75);
});

test("quota refresh keeps focus on the refresh button across a loading repaint", async () => {
  mountLiveOn("quota");
  useSession(async () => [sample()]);
  await act(async () => { await refreshAgentQuota(); });
  const refresh = appRoot().querySelector<HTMLButtonElement>(".quota-refresh");
  if (!(refresh instanceof HTMLButtonElement)) throw new Error("missing refresh");
  act(() => refresh.focus());
  expectSameNode(document.activeElement, refresh);
  // A subscription-driven re-render does not move focus.
  await act(async () => {
    useSession(async () => [{ ...sample(), plan: "pro2" }]);
    await refreshAgentQuota();
  });
  await settle();
  const again = appRoot().querySelector(".quota-refresh");
  expect(again).toBeInstanceOf(HTMLButtonElement);
  expectSameNode(document.activeElement, again);
});

test("the refresh mark turns once for each press, and not because a read is under way", async () => {
  mountLiveOn("quota");
  useSession(async () => [sample()]);
  await act(async () => { await refreshAgentQuota(); });
  const mark = () => appRoot().querySelector(".quota-refresh > svg")!;
  // A read the page started itself turns nothing.
  expect(mark().classList.contains("is-turning")).toBeFalse();
  const first = mark();
  await act(async () => appRoot().querySelector<HTMLButtonElement>(".quota-refresh")!.click());
  await settle();
  // The read is back already; the mark is a new node, so its turn plays whole.
  expect(mark().classList.contains("is-turning")).toBeTrue();
  expectDifferentNode(mark(), first);
  const turned = mark();
  await act(async () => { await refreshAgentQuota(); });
  expectSameNode(mark(), turned);
});

describe("Cursor CLI quota auth states", () => {
  const CMD = "export AGENT_CLI_CREDENTIAL_STORE=file\ncursor-agent login\npairfob service install";

  test("a refused Keychain read needs the reader: the hint and the exact three-line CLI command", async () => {
    mountLiveOn("quota");
    useSession(async () => [quotaOff("cursor", "needs_action", "allow_keychain")]);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const notice = appRoot().querySelector(".quota-attention #quota-cursor")!;
    expect(meterValue()).toBeNull();
    expect(notice.querySelector(".set-item-sub")!.textContent).toBe(t("quota.reason.allowKeychain"));
    expect(notice.textContent).not.toContain("desktop");
    expect(notice.textContent).not.toContain("桌面应用");
    // The way out is under the row, shut until it is opened, with the copyable command last.
    const toggle = notice.querySelector<HTMLButtonElement>("button.set-nav")!;
    const steps = notice.querySelector<HTMLElement>(".fold")!;
    expect([toggle.getAttribute("aria-expanded"), steps.inert, toggle.getAttribute("aria-controls")]).toEqual(["false", true, steps.id]);
    await act(async () => toggle.click());
    expect([toggle.getAttribute("aria-expanded"), steps.inert]).toEqual(["true", false]);
    expect(steps.textContent).toContain(t("quota.cursorKeychainHelp"));
    expect(steps.querySelector(".command-line code")!.textContent).toBe(CMD);
    expect(steps.textContent.indexOf(CMD)).toBeGreaterThan(steps.textContent.indexOf(t("quota.cursorKeychainHelp")));
  });

  test("an expired login keeps the CLI login guidance and its one command", async () => {
    mountLiveOn("quota");
    useSession(async () => [quotaOff("cursor", "needs_action", "relogin")]);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const notice = appRoot().querySelector(".quota-attention #quota-cursor")!;
    expect(notice.querySelector(".set-item-sub")!.textContent).toBe(t("quota.reason.relogin"));
    expect(notice.textContent).toContain(t("quota.cursorHelp"));
    expect(notice.textContent).not.toContain("export AGENT_CLI_CREDENTIAL_STORE");
    expect(notice.querySelector(".command-line code")!.textContent).toBe("cursor-agent login");
  });

  test("no login at all is not a task: it sits under the supported ones with the guidance and no command", async () => {
    mountLiveOn("quota");
    useSession(async () => [quotaOff("cursor", "not_configured", "no_login")]);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    expect(appRoot().querySelector(".quota-attention")).toBeNull();
    const row = appRoot().querySelector(".quota-others #quota-cursor")!;
    expect(meterValue()).toBeNull();
    expect(row.textContent).toContain(t("quota.reason.noLogin"));
    expect(row.textContent).toContain("cursor-agent login");
    expect(row.textContent).toContain(t("quota.cursorHelp"));
    expect(row.textContent).not.toContain("桌面应用");
    expect(row.querySelector(".command-line")).toBeNull();
    // Shut by default: one line names what is not set up.
    const toggle = appRoot().querySelector<HTMLButtonElement>(".quota-others button.set-nav")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("1 个未配置");
    expect(toggle.textContent).toContain("Cursor");
    expect(row.closest<HTMLElement>(".fold")!.inert).toBeTrue();
  });

  test("a login without subscription quota shows the dedicated Cursor guidance and no command", async () => {
    mountLiveOn("quota");
    useSession(async () => [quotaOff("cursor", "not_configured", "unsupported_login")]);
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const row = appRoot().querySelector(".quota-others #quota-cursor")!;
    expect(row.textContent).toContain(t("quota.reason.unsupportedLogin"));
    expect(row.textContent).toContain("cursor-agent login");
    expect(row.textContent).toContain(t("quota.cursorUnsupportedHelp"));
    expect(row.textContent).not.toContain("export AGENT_CLI_CREDENTIAL_STORE");
    expect(row.querySelector(".command-line")).toBeNull();
  });
});

describe("the quota page's groups", () => {
  const several = (): QuotaAccount[] => [
    sample(),
    quotaAccount({ provider: "claude", plan: "max", meters: [
      quotaShare({ name: "five hour", used_percent: 61 }),
      quotaShare({ name: "seven day opus", pool: "seven-day-opus", headline: false, used_percent: 88, window_minutes: 10080 }),
      quotaShare({ name: "seven day sonnet", pool: "seven-day-sonnet", headline: false, used_percent: 10, window_minutes: 10080 }),
    ] }),
    quotaOff("grok", "needs_action", "relogin"),
    quotaOff("copilot", "needs_action", "choose_account"),
    quotaOff("antigravity", "not_configured", "not_running"),
  ];

  test("what needs the reader comes first, then the cards, then what is not set up", async () => {
    mountLiveOn("quota");
    useSession(async () => several());
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const panel = appRoot().querySelector(".quota-panel")!;
    const order = [...panel.children].map(child => child.className.split(" ")[0] === "set-group" ? child.className.split(" ")[1] : child.className.split(" ")[0]);
    expect(order.filter(name => name !== "quota-lede")).toEqual(["quota-attention", "set-group-label", "quota-cards", "quota-others"]);
    expect(panel.querySelector(".quota-attention .set-group-label")!.textContent).toBe("需要处理 · 2");
    expect([...panel.querySelectorAll(".quota-notice .set-item-label")].map(node => node.textContent)).toEqual(["GitHub Copilot", "Grok Build"]);
    expect(panel.querySelector(".quota-cards-label")!.textContent).toBe("订阅 · 2刚刚更新");
    expect([...panel.querySelectorAll(".quota-card")].map(card => card.id)).toEqual(["quota-codex", "quota-claude"]);
    // With two or more, a wide page folds them into one strip that names each.
    const strip = panel.querySelector<HTMLButtonElement>(".quota-attention.has-strip .quota-strip")!;
    expect(strip.textContent).toContain("GitHub Copilot 电脑上有多个登录，还没选用哪个 · Grok Build 登录已过期");
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    await act(async () => strip.click());
    expect(panel.querySelector(".quota-attention")!.classList.contains("is-open")).toBeTrue();
    expect(strip.getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain(t("quota.why.title"));
  });

  test("a card's other allowances open and shut in place, and say that one is low while shut", async () => {
    mountLiveOn("quota");
    useSession(async () => several());
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const card = appRoot().querySelector("#quota-claude")!;
    const toggle = card.querySelector<HTMLButtonElement>(".quota-fold")!;
    const fold = card.querySelector<HTMLElement>(".fold")!;
    expect(toggle.textContent).toBe("其他额度 · 2 项1 项偏低");
    expect([toggle.getAttribute("aria-expanded"), fold.inert]).toEqual(["false", true]);
    expect([...card.querySelectorAll(":scope > .set-card > .quota-item .set-item-label")].map(node => node.textContent)).toEqual(["5 小时"]);
    await act(async () => toggle.click());
    expect([toggle.getAttribute("aria-expanded"), fold.inert]).toEqual(["true", false]);
    expect([...fold.querySelectorAll(".set-item-label")].map(node => node.textContent)).toEqual(["Opus 7 天", "Sonnet 7 天"]);
    // A refresh leaves the fold as the reader left it and the control where it was.
    act(() => toggle.focus());
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    expectSameNode(appRoot().querySelector("#quota-claude .quota-fold"), toggle);
    expectSameNode(document.activeElement, toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  test("an older computer is said to be older, with the way to update it, and not offered a command it lacks", async () => {
    mountLiveOn("quota");
    useSession(async () => [sample(), quotaOff("copilot", "failed", "unavailable"), quotaOff("grok", "not_configured", "sign_in")], { legacy: true, unknown: 0 });
    await act(async () => { await refreshAgentQuota(); });
    await settle();
    const note = appRoot().querySelector(".quota-legacy")!;
    expect(note.textContent).toBe(`${t("quota.legacyNote")}${t("quota.legacyUpdate")}`);
    expect(note.querySelector("button")).not.toBeNull();
    expect(appRoot().querySelector(".quota-attention")!.textContent).not.toContain("pairfob quota list");
    expect(appRoot().querySelector(".quota-others #quota-grok")!.textContent).toContain(t("quota.authRequired"));
    await act(async () => { useSession(async () => [sample(), quotaOff("copilot", "failed", "unavailable")], { legacy: false, unknown: 2 }); await refreshAgentQuota(); });
    await settle();
    expect(appRoot().querySelector(".quota-legacy")).toBeNull();
    expect(appRoot().querySelector(".quota-attention .command-line code")!.textContent).toBe("pairfob quota list");
    expect(appRoot().querySelector(".quota-panel")!.textContent).toContain(t("quota.unknownCount", { n: 2 }));
  });

  test("the cards and the settings rows follow the agents the reader starts most", async () => {
    localStorage.setItem(CREATE_MEMORY_KEY, JSON.stringify({ pinned: ["grok"], uses: { cursor: 9, codex: 2 }, pinsSeeded: true }));
    try {
      mountLiveOn("settings");
      useSession(async () => (["codex", "claude", "cursor", "grok"] as const).map(provider => quotaAccount({ provider })));
      await act(async () => { await refreshAgentQuota(); });
      await settle();
      expect([...appRoot().querySelectorAll(".quota-row .set-item-label")].map(node => node.textContent)).toEqual(["Grok", "Cursor", "Codex", "Claude"]);
      await act(async () => { openQuota(); });
      await settle();
      expect([...appRoot().querySelectorAll(".quota-card")].map(card => card.id)).toEqual(["quota-grok", "quota-cursor", "quota-codex", "quota-claude"]);
    } finally {
      localStorage.removeItem(CREATE_MEMORY_KEY);
    }
  });

  test("a refresh that changed nothing says so on the control for a moment", async () => {
    mountLiveOn("quota");
    const fixed = sample();
    useSession(async () => [fixed]);
    await act(async () => { await refreshAgentQuota(); });
    const refresh = appRoot().querySelector<HTMLButtonElement>(".quota-refresh")!;
    expect(refresh.textContent).toBe("刷新余量");
    await act(async () => refresh.click());
    await settle();
    expectSameNode(appRoot().querySelector(".quota-refresh"), refresh);
    expect(refresh.textContent).toBe(t("quota.upToDate"));
    expect(refresh.disabled).toBeFalse();
  });
});

test("a cached quota failure follows language switches without another request", async () => {
  mountLiveOn("quota");
  let calls = 0;
  useSession(async () => { calls++; throw new ProtocolError("unknown_op", "wire detail"); });
  await act(async () => { await refreshAgentQuota(); });
  const chinese = t("quota.upgrade");
  expect(appRoot().textContent).toContain(chinese);
  act(() => setLang("en"));
  expect(appRoot().textContent).toContain(t("quota.upgrade"));
  expect(appRoot().textContent).not.toContain(chinese);
  expect(calls).toBe(1);
});
