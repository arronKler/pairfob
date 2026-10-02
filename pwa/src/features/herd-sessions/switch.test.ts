import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { createElement, renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { t } from "../../lib/i18n";
import type { HerdSessionSummary, LiveSession, PairResult, SessionEvent } from "../../lib/protocol/client";
import { closeComputerSession, establish, refreshRuntimeState, refreshSnapshot, switchHerdSession } from "../connection/controller";
import { attachLiveSession, currentHerdSession, liveSession, setCredential } from "../computers/catalog-store";
import { capturePairingFragment, clearNotificationTarget, setNetworkOnline, setPhase } from "../connection/connection-store";
import { dashboardStore } from "../dashboard/catalog-store";
import { capabilityEnabled, advertisedAgentKinds } from "../operations/capabilities-store";
import { resetObservationLifecycle, resetPaneView, selectPane, setFullTerminal } from "../session/session-store";
import { setScreen } from "../../app/navigation-store";
import { resetGenerationsForTests } from "../connection/generations";
import { loadHerdSessions } from "./load";
import { HerdSessionSwitch } from "./herd-session-row";
import { herdSessionList } from "./store";
import { adoptIncoming, attachmentScopeKey, resetAttachmentQueues, setRuntimeAbort } from "../session/attachments/attachments-store";
import { resetAttachmentRecovery } from "../session/attachments/attachments-recovery";
import { resetTelemetry } from "../../lib/telemetry";

/**
 * Regression coverage for the review of the first multi-session attempt
 * (arronKler/pairfob#3): the selection belongs to the connection, a switch is a
 * complete view transition, config follows the selected session, and list reads
 * are owned by the connection and request that started them.
 */

type FakeSession = LiveSession & {
  emit: (event: SessionEvent) => void;
  configs: (string | null)[];
  listReads: number;
};

function pair(daemonId: string): PairResult {
  return {
    daemonId, deviceId: `phone_${daemonId}`, psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
    relayOrigin: "https://pairfob.com", fp: `fp_${daemonId}`, label: "test", createdAt: 1,
  };
}

/** GetConfig for one Herdr session: the default is stopped, a named session is live. */
function configFor(herd: string | null): Record<string, unknown> {
  const capabilities: Record<string, boolean> = {};
  for (const key of [
    "create_conversation", "create_tab", "split_pane", "prompt_agent", "history",
    "list_worktrees", "create_worktree", "open_worktree", "resize_pane", "swap_pane", "zoom_pane",
  ]) capabilities[key] = herd !== null;
  capabilities.list_sessions = true;
  return {
    protocol: 1, build: "v1.0.0", daemon_id: "d_aaaaaaaaaaaaaaaaaaaa", hostname: "herdbox",
    runtime: herd === null ? "offline" : "herdr", vapid_public: "", submit_keys: ["Enter"], idle_pause_ms: 5000,
    push_delivery: "webpush", push_enabled: false, capabilities, agent_kinds: herd === null ? [] : ["codex"],
  };
}

function panesFor(herd: string | null) {
  return { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: `/tmp/${herd ?? "default"}`, agent: "codex" }] };
}

function fakeSession(sessions: HerdSessionSummary[] = [{ name: null, running: false }, { name: "work", running: true }]): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>();
  let herd: string | null = null;
  const session = {
    configs: [] as (string | null)[],
    listReads: 0,
    close: () => undefined,
    isConnected: () => true,
    setNetworkAvailable: () => undefined,
    reconnectNow: () => undefined,
    switchTransport: async () => undefined,
    onEvent: (listener: (event: SessionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: (event: SessionEvent) => { for (const listener of listeners) listener(event); },
    // Each read answers for the session selected when it was issued, like the wire.
    getConfig: async () => { const target = herd; session.configs.push(target); return configFor(target); },
    snapshot: async () => panesFor(herd),
    herdSession: () => herd,
    selectHerdSession: (name: string | null) => { herd = name; },
    listHerdSessions: async () => { session.listReads++; return sessions; },
  } as unknown as FakeSession;
  return session;
}

const daemonIds = ["herd_switch_a", "herd_switch_b"];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
let beaconBefore: PropertyDescriptor | undefined;

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  resetGenerationsForTests();
  setNetworkOnline(true);
  beaconBefore = Object.getOwnPropertyDescriptor(happy.navigator, "sendBeacon");
  Object.defineProperty(happy.navigator, "sendBeacon", { configurable: true, value: () => true });
  resetTelemetry();
});

afterEach(() => {
  clearNotificationTarget();
  resetTelemetry();
  if (beaconBefore) Object.defineProperty(happy.navigator, "sendBeacon", beaconBefore);
  else Reflect.deleteProperty(happy.navigator, "sendBeacon");
  resetAttachmentRecovery();
  resetAttachmentQueues();
  unmountReact();
  for (const daemonId of daemonIds) closeComputerSession(daemonId);
  attachLiveSession(null);
  setCredential(null);
  setPhase("pick");
  setScreen("home");
  setFullTerminal(false);
  selectPane("");
  resetPaneView();
  resetObservationLifecycle();
});

async function connectBoth() {
  const created = new Map<string, FakeSession>();
  const connect = async (credential: PairResult) => {
    const session = fakeSession();
    created.set(credential.daemonId, session);
    return session;
  };
  await establish(pair(daemonIds[0]), connect);
  return { created, connect };
}

describe("Herdr session selection belongs to the connection", () => {
  test("computer B does not inherit A's selection, and selecting it on B still switches", async () => {
    const { created, connect } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    expect(await switchHerdSession("work")).toBe(true);
    expect(currentHerdSession()).toBe("work");

    await establish(pair(daemonIds[1]), connect);
    const b = created.get(daemonIds[1])!;
    expect(liveSession()).toBe(b);
    expect(currentHerdSession()).toBeNull();
    // The first attempt early-returned here because a global "current" still said "work".
    expect(await switchHerdSession("work")).toBe(true);
    expect(b.herdSession!()).toBe("work");

    // Reusing A from the pool shows A's own choice.
    await establish(pair(daemonIds[0]), connect);
    expect(liveSession()).toBe(a);
    expect(currentHerdSession()).toBe("work");
  });
});

describe("a switch is a complete view transition", () => {
  test("a snapshot issued before the switch cannot populate the new session's dashboard", async () => {
    const { created } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    let resolveOld!: (snapshot: unknown) => void;
    const original = a.snapshot;
    a.snapshot = () => new Promise((resolve) => { resolveOld = resolve; });
    const stale = refreshSnapshot();
    await flush();
    a.snapshot = original;

    expect(await switchHerdSession("work")).toBe(true);
    const fresh = dashboardStore.get().agents.map((agent) => agent.cwd);
    resolveOld({ panes: [{ pane_id: "w9:p9", workspace_id: "w9", tab_id: "w9:t1", cwd: "/tmp/stale", agent: "codex" }] });
    await stale;

    expect(dashboardStore.get().agents.map((agent) => agent.cwd)).toEqual(fresh);
    expect(fresh).toEqual(["/tmp/work"]);
  });

  test("an open pane from the old session is left, settings stay put", async () => {
    await connectBoth();
    setScreen("pane");
    selectPane("w1:p1");
    expect(await switchHerdSession("work")).toBe(true);
    const { navigationStore } = await import("../../app/navigation-store");
    expect(navigationStore.get().screen).toBe("home");

    setScreen("settings");
    expect(await switchHerdSession(null)).toBe(true);
    expect(navigationStore.get().screen).toBe("settings");
  });
});

describe("config follows the selected session", () => {
  test("default stopped, named running: capabilities and agent kinds come from the named session", async () => {
    const { created } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    expect(capabilityEnabled("create_tab")).toBe(false);
    expect(advertisedAgentKinds()).toEqual([]);

    expect(await switchHerdSession("work")).toBe(true);
    expect(a.configs.at(-1)).toBe("work");
    expect(capabilityEnabled("create_tab")).toBe(true);
    expect(advertisedAgentKinds()).toEqual(["codex"]);

    expect(await switchHerdSession(null)).toBe(true);
    expect(capabilityEnabled("create_tab")).toBe(false);
  });
});

describe("list reads are owned by their connection and request", () => {
  test("a late list from computer A neither lands on B nor hides B's switcher", async () => {
    const { created, connect } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    let resolveA!: (sessions: HerdSessionSummary[]) => void;
    let rejectA!: (error: Error) => void;
    a.listHerdSessions = () => new Promise((resolve, reject) => { resolveA = resolve; rejectA = reject; });
    const lateA = loadHerdSessions();

    await establish(pair(daemonIds[1]), connect);
    const b = created.get(daemonIds[1])!;
    await loadHerdSessions();
    // Every runtime refresh re-reads B's own list, so the check is its content:
    // A's late answer never replaces it, and A's failure never hides it.
    const bNames = () => herdSessionList(b)?.sessions.map((s) => s.name);
    expect(bNames()).toEqual([null, "work"]);

    resolveA([{ name: null, running: true }, { name: "elsewhere", running: true }]);
    await lateA;
    expect(bNames()).toEqual([null, "work"]);

    a.listHerdSessions = () => new Promise((resolve, reject) => { resolveA = resolve; rejectA = reject; });
    await establish(pair(daemonIds[0]), connect);
    const failingA = loadHerdSessions();
    await establish(pair(daemonIds[1]), connect);
    rejectA(new Error("unsupported"));
    await failingA;
    expect(bNames()).toEqual([null, "work"]);
  });

  test("an older read on the same connection cannot overwrite a newer one", async () => {
    const { created } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    const answers: ((sessions: HerdSessionSummary[]) => void)[] = [];
    a.listHerdSessions = () => new Promise((resolve) => { answers.push(resolve); });
    const older = loadHerdSessions();
    const newer = loadHerdSessions();
    answers[1]([{ name: null, running: true }, { name: "new", running: true }]);
    await newer;
    answers[0]([{ name: null, running: true }, { name: "old", running: true }]);
    await older;
    expect(herdSessionList(a)?.sessions.map((s) => s.name)).toEqual([null, "new"]);
  });

});

describe("the Sessions tab offers the switch without a Settings visit", () => {
  const nextTask = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); await flush(); });
  const pill = () => appRoot().querySelector<HTMLButtonElement>(".herd-session-switch");

  test("connecting reads the list, and the pill switches the live connection", async () => {
    const { created } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    // No loadHerdSessions() call here: the runtime refresh after connect read it.
    await flush();
    expect(herdSessionList(a)?.sessions.map((s) => s.name)).toEqual([null, "work"]);

    renderReact(createElement(HerdSessionSwitch));
    expect(pill()?.textContent).toBe(t("set.herdSessionDefault"));
    act(() => pill()!.click());
    const work = [...document.querySelectorAll<HTMLButtonElement>(".sheet-body .menu-choice")]
      .find((node) => node.querySelector(".menu-choice-title")?.textContent === "work")!;
    await act(async () => { work.click(); await flush(); });
    await nextTask();
    expect(a.herdSession!()).toBe("work");
    expect(pill()?.textContent).toBe("work");
  });

  for (const advertised of [false, undefined]) {
    test(`list_sessions=${advertised}: no discovery RPC or switcher`, async () => {
      const a = fakeSession();
      a.getConfig = async () => {
        const config = configFor(null);
        const capabilities = config.capabilities as Record<string, boolean>;
        if (advertised === undefined) delete capabilities.list_sessions;
        else capabilities.list_sessions = advertised;
        return config;
      };
      await establish(pair(daemonIds[0]), async () => a);
      await loadHerdSessions();
      expect(a.listReads).toBe(0);
      expect(herdSessionList(a)).toBeUndefined();
      renderReact(createElement(HerdSessionSwitch));
      expect(pill()).toBeNull();
    });
  }

  test("an offline default still advertises discovery and reads once after each config refresh", async () => {
    const { created } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    expect(capabilityEnabled("create_tab")).toBe(false);
    expect(capabilityEnabled("list_sessions")).toBe(true);
    expect(a.listReads).toBe(1);
    renderReact(createElement(HerdSessionSwitch));
    expect(pill()).not.toBeNull();
    await act(async () => { await refreshRuntimeState(); await flush(); });
    expect(a.listReads).toBe(2);
  });

  test("a switch keeps the cached choices until the target's config answers", async () => {
    const { created } = await connectBoth();
    const a = created.get(daemonIds[0])!;
    renderReact(createElement(HerdSessionSwitch));
    let answer!: (config: Record<string, unknown>) => void;
    a.getConfig = () => new Promise(resolve => { answer = resolve; });
    let switching!: Promise<boolean>;
    act(() => { switching = switchHerdSession("work"); });
    await act(async () => { await flush(); });
    expect(pill()).not.toBeNull();
    const config = configFor("work");
    (config.capabilities as Record<string, boolean>).list_sessions = false;
    await act(async () => { answer(config); await switching; await flush(); });
    expect(herdSessionList(a)).toBeUndefined();
  });
});

test("a committed attachment is absent from another Herdr session's equal pane ID", async () => {
  const { resetAttachmentQueues, attachmentScopeKey, adoptIncoming, patchItem } = await import("../session/attachments/attachments-store");
  const { currentAttachmentScope, scopeMatches } = await import("../session/attachments/attachments-context");
  const { sendAttachmentsState } = await import("../session/attachments/attachments-send");
  resetAttachmentQueues();
  await connectBoth();
  setScreen("pane");
  selectPane("w1:p1");
  const oldScope = currentAttachmentScope()!;
  const key = attachmentScopeKey(oldScope);
  const file = new File(["private attachment"], "private.txt", { type: "text/plain" });
  const localId = adoptIncoming(key, oldScope, [file])[0]!;
  patchItem(key, localId, { status: "committed", path: "/tmp/default/.pairfob/attachments/private.txt" });
  expect(sendAttachmentsState().readyPaths).toEqual(["/tmp/default/.pairfob/attachments/private.txt"]);
  await switchHerdSession("work");
  setScreen("pane");
  selectPane("w1:p1");
  expect(scopeMatches(oldScope)).toBe(false);
  expect(sendAttachmentsState().readyPaths).toEqual([]);
});

test("retrying an old failed worktree never mutates the newly selected Herdr session", async () => {
  const { createWorktreeFrom } = await import("../operations/controller");
  const { worktreeJobs, retryWorktreeJob, dismissWorktreeJob } = await import("../../lib/worktree-jobs");
  for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
  const { created } = await connectBoth();
  const a = created.get(daemonIds[0])!;
  await switchHerdSession("work");
  const targets: (string | null)[] = [];
  a.createWorktree = async () => { targets.push(a.herdSession!()); throw new Error("create failed"); };
  expect(createWorktreeFrom({ workspace_id: "w1", branch: "test-branch" })).toBe(true);
  await flush();
  const job = worktreeJobs()[0]!;
  expect(job.status).toBe("failed");
  await switchHerdSession("other");
  try {
    retryWorktreeJob(job.id);
    await flush();
    expect(targets).toEqual(["work"]);
    await switchHerdSession("work");
    retryWorktreeJob(job.id);
    await flush();
    expect(targets).toEqual(["work", "work"]);
  } finally { dismissWorktreeJob(job.id); }
});

test("a late worktree result cannot open the same pane ID in another Herdr session", async () => {
  const { createWorktreeFrom } = await import("../operations/controller");
  const { worktreeJobs, dismissWorktreeJob } = await import("../../lib/worktree-jobs");
  for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
  const { created } = await connectBoth();
  const a = created.get(daemonIds[0])!;
  await switchHerdSession("work");
  let resolveWorktree!: (value: never) => void;
  a.createWorktree = () => new Promise((resolve) => { resolveWorktree = resolve; });
  const opened: (string | null)[] = [];
  a.paneRead = async () => { opened.push(a.herdSession!()); return { text: "other pane", hash: "hash" }; };
  expect(createWorktreeFrom({ workspace_id: "w1", branch: "test-branch" })).toBe(true);
  await flush();
  await switchHerdSession("other");
  resolveWorktree({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } as never);
  for (let i=0; i<50; i++) await Promise.resolve();
  expect(opened).toEqual([]);
});

test("switching away and back preserves a previously read completion", async () => {
  const { acknowledgePaneCompletion } = await import("../dashboard/catalog-store");
  const { created } = await connectBoth();
  const a = created.get(daemonIds[0])!;
  a.snapshot = async () => ({ session: a.herdSession!() ?? "default", panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: "done", cwd: "/tmp/one", state_change_seq: 1 }] });
  await switchHerdSession("work");
  expect(acknowledgePaneCompletion("w1:p1")).toBe(true);
  expect(dashboardStore.get().agents[0]?.status).toBe("idle");
  await switchHerdSession("other");
  await switchHerdSession("work");
  expect(dashboardStore.get().agents[0]?.status).toBe("idle");
});

test("a session switch aborts old uploads before their shared RPC target moves", async () => {
  const { created } = await connectBoth();
  const a = created.get(daemonIds[0])!;
  await switchHerdSession("work");
  const scope = { daemonId: daemonIds[0], herdSession: "work", paneId: "w1:p1" };
  const key = attachmentScopeKey(scope);
  const [localId] = adoptIncoming(key, scope, [new File(["bytes"], "queued.bin")]);
  const abort = new AbortController();
  setRuntimeAbort(key, localId, abort);
  const select = a.selectHerdSession!;
  a.selectHerdSession = (name) => {
    expect(abort.signal.aborted).toBe(true);
    select(name);
  };
  await switchHerdSession("other");
  expect(a.herdSession!()).toBe("other");
});

test("worktree reconciliation cannot issue a later list against a different Herdr session", async () => {
  const { createWorktreeFrom } = await import("../operations/controller");
  const { worktreeJobs, dismissWorktreeJob } = await import("../../lib/worktree-jobs");
  const { ProtocolError } = await import("../../lib/protocol/client");
  for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
  const { created } = await connectBoth();
  const a = created.get(daemonIds[0])!;
  await switchHerdSession("work");
  let resolveSnapshot!: (value: Record<string, unknown>) => void;
  a.snapshot = () => a.herdSession!() === "work"
    ? new Promise(resolve => { resolveSnapshot = resolve; })
    : Promise.resolve(panesFor(a.herdSession!()));
  const listed: (string | null)[] = [];
  a.listWorktrees = async () => { listed.push(a.herdSession!()); return { worktrees: [] }; };
  a.createWorktree = async () => { throw new ProtocolError("unknown_outcome", "uncertain"); };
  expect(createWorktreeFrom({ workspace_id: "w1" })).toBe(true);
  await flush();
  await switchHerdSession("other");
  resolveSnapshot(panesFor("work"));
  await flush();
  try { expect(listed).toEqual([]); }
  finally { for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id); }
});

test("a notification snapshot switches the real controller to default before opening a repeated pane id", async () => {
  const notificationDaemon = "d_9123456789abcdef0123";
  const a = fakeSession();
  await establish(pair(notificationDaemon), async () => a);
  await switchHerdSession("work");
  const opened: (string | null)[] = [];
  a.paneRead = async () => { opened.push(a.herdSession!()); return { text: "default pane", hash: "hash" }; };
  const locationBefore = globalThis.location;
  const historyBefore = globalThis.history;
  try {
    Object.assign(globalThis, {
      location: { hash: `#notify=1&d=${notificationDaemon}&pane=w1:p1`, pathname: "/pair", search: "" },
      history: { replaceState() {} },
    });
    capturePairingFragment();
    await refreshSnapshot();
    expect(currentHerdSession()).toBeNull();
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every(name => name === null)).toBe(true);
  } finally {
    closeComputerSession(notificationDaemon);
    Object.assign(globalThis, { location: locationBefore, history: historyBefore });
  }
});
