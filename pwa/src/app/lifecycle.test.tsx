import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { act } from "react";
import { resetBoardTestDOM } from "../../test-support/dom";
import { happy } from "../../test-support/dom";
import type { LiveSession } from "../lib/protocol/client";

const { applicationIsRunning, startApplication, stopApplication } = await import("./bootstrap");
const { commitApp, isCommitting, requestCommit, resetCommitState } = await import("./commit");
const { appRoot } = await import("./dom-root");
const { appHost, registerAppHost, releaseAppHost } = await import("./host");
const { frameStore, getAppFrame, registerSessionOwnerPreparer, resetFrame } = await import("./frame");
const { isAppMounted, isMounting, mountApp, unmountApp } = await import("./mount");
const { clearShell } = await import("./shell");
const { setOperationBusy } = await import("../features/operations/capabilities-store");
const { connectionStore, noteRelayRtt, setNetworkOnline, setPhase } = await import("../features/connection/connection-store");
const { navigationStore, setComputersFrom, setScreen } = await import("./navigation-store");
const { preferencesStore, listGroupCollapsed } = await import("../features/settings/preferences-store");
const { hasDirtyDomains, publishAllDomains } = await import("./domain-publication");
const { applyPaneRead, selectPane, sessionStore, openPaneId, setAgentChat, setFullTerminal, setTermSelect, resetPaneView } = await import("../features/session/session-store");
const { batching } = await import("../shared/model/domain-store");
const { setCredential, setComputers, setAddingComputer, attachLiveSession } = await import("../features/computers/catalog-store");
const { setTermFontPx, setListGroup, setListGroupCollapsed } = await import("../features/settings/preferences-store");
const { replaceAgentsFromSnapshot } = await import("../features/dashboard/catalog-store");
const { clearNotice } = await import("./notices-store");
const { setBoardReturn } = await import("../features/board/layout-store");

function session(): LiveSession {
  return { isConnected: () => true } as LiveSession;
}

function paneCard(paneId: string) {
  return { pane_id: paneId, workspace_id: "w1", tab_id: "t1", agent: "codex", agent_status: "idle" as const };
}

/** A live guided/chat pane scene with the given panes, via typed domain actions. */
function livePaneScene(agentChat: boolean, paneIds: readonly string[] = ["p1"]): void {
  setPhase("live");
  setScreen("pane");
  selectPane(paneIds[0] ?? "p1");
  setAgentChat(agentChat);
  attachLiveSession(session());
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "t1", pane_id: paneIds[0] ?? "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/demo" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "demo" }],
    panes: paneIds.map((paneId) => paneCard(paneId)),
  });
}

/** Reset the domains this suite touches to the home/baseline (typed actions). */
function resetLifecycleDomains(): void {
  // Flush staged/dirty writes first without clearing subscribers.
  publishAllDomains();
  setFullTerminal(false);
  setAgentChat(false);
  setTermSelect(false);
  setBoardReturn(false);
  clearNotice();
  setOperationBusy(false);
  setTermFontPx(12);
  setListGroup("flat");
  setListGroupCollapsed({});
  setComputersFrom("home");
  setAddingComputer(false);
  setPhase("boot");
  setScreen("home");
  setCredential(null);
  setComputers([]);
  resetPaneView();
  selectPane("");
  attachLiveSession(null);
  replaceAgentsFromSnapshot({ panes: [] });
  setNetworkOnline(true);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  registerSessionOwnerPreparer(null);
  resetLifecycleDomains();
  publishAllDomains();
  resetCommitState();
});

afterEach(() => {
  registerSessionOwnerPreparer(null);
  if (applicationIsRunning()) act(() => { stopApplication(); });
  if (isAppMounted() || isMounting()) act(() => { unmountApp(); });
  const active = appHost();
  if (active) releaseAppHost(active);
  resetCommitState();
  resetFrame();
  clearShell();
  resetLifecycleDomains();
});

function shown(selector: string): boolean {
  return Boolean(appRoot().querySelector(selector));
}

describe("staged composition publication", () => {
  test("an ordinary write cannot publish a staged composition before its frame", () => {
    livePaneScene(false);
    publishAllDomains();
    act(() => { mountApp(); });
    const seen: Array<{ phase: string; frame: string | undefined }> = [];
    const release = connectionStore.subscribe(() => {
      seen.push({ phase: connectionStore.get().phase, frame: getAppFrame().layout?.key.split(":")[1] });
    });
    setPhase("connect");
    noteRelayRtt(3);
    expect(seen).toEqual([]);
    act(() => { commitApp(); });
    expect(seen.every((entry) => entry.phase === entry.frame)).toBeTrue();
    expect(shown(".prelude")).toBeTrue();
    release();
  });

  test("writeIf on a staged session domain stays coherent with the owner binding", async () => {
    livePaneScene(false, ["p1","p2"]);
    publishAllDomains();
    act(() => { mountApp(); });
    const seen: Array<{ paneId: string; bound: string | undefined }> = [];
    const release = sessionStore.subscribe(() => {
      seen.push({ paneId: sessionStore.get().paneId, bound: getAppFrame().session?.paneId });
    });
    selectPane("p2");
    setTermSelect(true);
    // Canonical staged-write observation: BEFORE the commit publishes, the live
    // domain read already reflects the select (the owner binding catches up on
    // the commit), while subscribers have not yet run.
    expect(openPaneId()).toBe("p2");
    expect(seen).toEqual([]);
    await act(async () => { commitApp(); });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.paneId === entry.bound)).toBeTrue();
    expect(getAppFrame().session?.paneId).toBe("p2");
    release();
  });

  test("setScreen then setComputersFrom does not publish navigation before the frame", () => {
    livePaneScene(false);
    publishAllDomains();
    act(() => { mountApp(); });
    const seen: Array<{ screen: string; mode: string | undefined }> = [];
    const release = navigationStore.subscribe(() => {
      seen.push({ screen: navigationStore.get().screen, mode: getAppFrame().layout?.mode });
    });
    setScreen("settings");
    setComputersFrom("settings");
    expect(seen).toEqual([]);
    act(() => { commitApp(); });
    expect(seen.every((entry) => entry.screen === "settings" && entry.mode === "settings")).toBeTrue();
    release();
  });

  test("setAgentChat then applyPaneRead does not publish chat before the frame", async () => {
    livePaneScene(false);
    publishAllDomains();
    act(() => { mountApp(); });
    const seen: Array<{ chat: boolean; mode: string | undefined }> = [];
    const release = sessionStore.subscribe(() => {
      seen.push({ chat: sessionStore.get().agentChat, mode: getAppFrame().layout?.mode });
    });
    setAgentChat(true);
    applyPaneRead("new", "new");
    expect(seen).toEqual([]);
    await act(async () => {
      commitApp();
      await Promise.resolve();
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.chat === (entry.mode === "chat"))).toBeTrue();
    release();
  });
});

describe("preparation publication", () => {
  test("home grouping normalization publishes with the frame that consumed it", () => {
    setPhase("live");
    setScreen("home");
    setListGroup("space");
    setListGroupCollapsed({ obsolete: true });
    // Real single-pane home input the frame consumes; its group normalization
    // reconciles the stale "obsolete" collapse against the live agents.
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/demo" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/demo", agent: "codex", agent_status: "idle" as const }],
    });
    publishAllDomains();
    const observations: Array<{ published: unknown; current: unknown; dirty: boolean }> = [];
    const release = frameStore.subscribe(() => {
      observations.push({
        published: preferencesStore.get().listGroupCollapsed,
        // Canonical current (live record), not the published snapshot: before
        // the frame settles the collapse is reconciled in the live domain.
        current: listGroupCollapsed(),
        dirty: hasDirtyDomains(),
      });
    });
    act(() => { mountApp(); });
    expect(hasDirtyDomains()).toBeFalse();
    expect(observations.every((entry) => entry.dirty === false)).toBeTrue();
    expect(observations.every((entry) => JSON.stringify(entry.published) === JSON.stringify(entry.current))).toBeTrue();
    release();
  });
});

describe("initial mount ownership", () => {
  test("a failed initial preparer leaves no host and restores flags", () => {
    livePaneScene(true);
    publishAllDomains();
    registerSessionOwnerPreparer(() => {
      throw new Error("preparation failed");
    });
    let thrown = false;
    try {
      act(() => { mountApp(); });
    } catch {
      thrown = true;
    }
    registerSessionOwnerPreparer(null);
    expect(thrown).toBeTrue();
    expect(isAppMounted()).toBeFalse();
    expect(appHost()).toBeNull();
    expect(isCommitting()).toBeFalse();
    expect(batching()).toBeFalse();
    act(() => { unmountApp(); });
    expect(appHost()).toBeNull();
  });

  test("an initial-frame subscriber can cancel mounting through the host", () => {
    let called = false;
    const release = frameStore.subscribe(() => {
      if (!called) {
        called = true;
        appHost()?.unmount();
      }
    });
    act(() => { mountApp(); });
    expect(called).toBeTrue();
    expect(isAppMounted()).toBeFalse();
    expect(appHost()).toBeNull();
    release();
  });

  test("first mount applies the shell before the first child layout effect measures it", () => {
    // The boot leaf runs in its own fresh process (scripts/shell-before-render-probe)
    // because an in-suite mock.module of pages/boot does not reliably restore for
    // other files sharing this worker. The probe replaces only BootScreen with a
    // leaf that measures the shell in its real layout effect, mounts the real App
    // for the boot composition and asserts the shell was already applied. This is
    // the original first-child layout-effect-time observation, without a fake
    // adoption.
    setPhase("boot");
    setScreen("home");
    publishAllDomains();
    const pwaRoot = fileURLToPath(new URL("../..", import.meta.url));
    const run = spawnSync(process.execPath, ["scripts/shell-before-render-probe.ts"], {
      cwd: pwaRoot,
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const diagnostics = `shell probe: status=${run.status}, signal=${run.signal}, error=${run.error?.message ?? "none"}
stdout: ${run.stdout}
stderr: ${run.stderr}`;
    if (run.error || run.status !== 0) throw new Error(diagnostics);
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch (error) {
      throw new Error(`${diagnostics}
Invalid probe JSON: ${String(error)}`);
    }
    const report = parsed as {
      ok: boolean; observed: boolean | undefined; shellAtNotification: boolean | undefined; error?: string;
    };
    expect(report.ok, report.error).toBeTrue();
    // The leaf measured the applied shell inside its own layout effect.
    expect(report.observed).toBeTrue();
    expect(run.status).toBe(0);

    // Extra in-process subscriber: the shell is also already on the root when
    // frame consumers are first notified on the first mount, before React renders.
    let shellAtPublish: boolean | undefined;
    const release = frameStore.subscribe(() => {
      if (shellAtPublish === undefined) {
        shellAtPublish = appRoot().classList.contains("boot-screen");
      }
    });
    act(() => { mountApp(); });
    release();
    expect(shellAtPublish).toBeTrue();
    expect(appRoot().classList.contains("boot-screen")).toBeTrue();
    expect(report.shellAtNotification).toBeTrue();
  }, 35_000);

  test("a nested commit during first prepare cannot be consumed by a stale adoption", () => {
    livePaneScene(false);
    publishAllDomains();
    let prepares = 0;
    registerSessionOwnerPreparer(() => {
      prepares += 1;
      // The real session preparer calls the installed host's synchronous commit
      // during the initial preparation: a nested commit joins the in-flight pass
      // instead of preparing again. Preparation runs exactly once, the App stays
      // mounted, and the correct guided DOM/frame/owner arrives. No adopted
      // element or key oracle is involved.
      appHost()?.commit({ sync: true });
    });
    act(() => { mountApp(); });
    expect(prepares).toBe(1);
    expect(isAppMounted()).toBeTrue();
    expect(shown(".session-pane, .pane-root")).toBeTrue();
    expect(getAppFrame().layout?.mode).toBe("pane");
    expect(getAppFrame().session?.paneId).toBe("p1");
  });

  test("a throwing ordinary preparation restores flags and a later commit recovers", async () => {
    act(() => { mountApp(); });
    livePaneScene(true);
    registerSessionOwnerPreparer(() => {
      throw new Error("owned preparation failure");
    });
    let threw = false;
    try {
      act(() => { commitApp(); });
    } catch {
      threw = true;
    }
    expect(threw).toBeTrue();
    expect(isCommitting()).toBeFalse();
    expect(batching()).toBeFalse();
    registerSessionOwnerPreparer(null);
    await act(async () => { commitApp(); });
    expect(getAppFrame().layout?.mode).toBe("chat");
  });
});

describe("typed shell inputs", () => {
  test("setOperationBusy updates aria-busy and the prepared frame without a legacy paint", () => {
    act(() => { mountApp(); });
    act(() => { setOperationBusy(true); });
    expect(appRoot().getAttribute("aria-busy")).toBe("true");
    expect(getAppFrame().layout?.operationBusy).toBeTrue();
    act(() => { unmountApp(); });
    expect(appRoot().getAttribute("aria-busy")).toBeNull();
  });

  test("setTermFont updates the CSS metric and the prepared frame without a legacy paint", () => {
    act(() => { mountApp(); });
    act(() => { setTermFontPx(17); });
    expect(appRoot().style.getPropertyValue("--term-fs")).toBe("17px");
    expect(getAppFrame().layout?.termFontPx).toBe(17);
  });
});

describe("stable App navigation", () => {
  test("a typed phase action recomposes synchronously through the mounted App", () => {
    setPhase("connect");
    publishAllDomains();
    act(() => { mountApp(); });
    expect(shown(".prelude")).toBeTrue();
    act(() => {
      setPhase("pick");
      commitApp();
      expect(getAppFrame().layout?.mode).toBe("pick");
      expect(shown(".computer-list")).toBeTrue();
      expect(shown(".prelude")).toBeFalse();
    });
  });
});

describe("start and stop", () => {
  test("start is idempotent and stop releases the host", () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ protocol: 2, build: "test", p2p: true }), {
      status: 200,
    })) as typeof fetch;
    try {
      let first: () => void;
      act(() => { first = startApplication(); });
      const host = appHost();
      expect(host).not.toBeNull();
      expect(startApplication()).toBe(first!);
      expect(appHost()).toBe(host);
      act(() => { stopApplication(); });
      expect(applicationIsRunning()).toBeFalse();
      expect(appHost()).toBeNull();
      expect(isAppMounted()).toBeFalse();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("retained commit controls", () => {
  test("explicit commit cancels a queued request and unmount cancels later work", async () => {
    act(() => { mountApp(); });
    let frames = 0;
    const release = frameStore.subscribe(() => { frames += 1; });
    await act(async () => {
      requestCommit();
      commitApp();
      await Promise.resolve();
    });
    expect(frames).toBe(1);
    await act(async () => {
      requestCommit();
      unmountApp();
    });
    const count = frames;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(frames).toBe(count);
    expect(appHost()).toBeNull();
    expect(isAppMounted()).toBeFalse();
    release();
  });
});
