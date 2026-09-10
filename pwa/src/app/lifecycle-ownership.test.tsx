import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM, happy } from "../../test-support/dom";
import type { LiveSession } from "../lib/protocol/client";

const { commitApp, isCommitting, resetCommitState } = await import("./commit");
const { appRoot } = await import("./dom-root");
const { appHost, releaseAppHost } = await import("./host");
const { frameStore, getAppFrame, registerSessionOwnerPreparer, resetFrame } = await import("./frame");
const { isAppMounted, mountApp, unmountApp } = await import("./mount");
const { followLayoutInputs, getLayout, layoutStore, publishedLayout, refreshPublishedLayout, resetLayout } =
  await import("./layout-store");
const { batching, flushNotifications } = await import("../shared/model/domain-store");
const { connectionStore, setNetworkOnline, setPhase } = await import("../features/connection/connection-store");
const { navigationStore, setScreen, setComputersFrom } = await import("./navigation-store");
const { resetPaneView, selectPane, sessionStore, setAgentChat, setFullTerminal, setTermSelect } = await import("../features/session/session-store");
const { applyTrace } = await import("../features/session/chat/trace-store");
const { setComposeDraft } = await import("../features/session/compose-store");
const { setTermFontPx, setListGroup, setListGroupCollapsed } = await import("../features/settings/preferences-store");
const { hasPendingComposition, publishAllDomains } = await import("./domain-publication");
const { attachLiveSession, setCredential, setComputers, setAddingComputer } = await import("../features/computers/catalog-store");
const { replaceAgentsFromSnapshot } = await import("../features/dashboard/catalog-store");
const { clearNotice } = await import("./notices-store");
const { setBoardReturn } = await import("../features/board/layout-store");
const { setOperationBusy } = await import("../features/operations/capabilities-store");
const { clearShell } = await import("./shell");
const { startApplication, stopApplication, applicationIsRunning } = await import("./bootstrap");
const { chatStore } = await import("../features/session/chat/trace-store");
const { composeStore } = await import("../features/session/compose-store");

function session(): LiveSession {
  return { isConnected: () => true } as LiveSession;
}

const pane = { paneId: "p1", agent: "codex", hasAgent: true, status: "idle", workspaceLabel: "demo", cwd: "/d" };

/** A live chat pane scene with the given panes, via named domain actions. */
function liveChatScene(paneIds: readonly string[] = ["p1"]): void {
  setPhase("live");
  setScreen("pane");
  selectPane(paneIds[0] ?? "p1");
  setAgentChat(true);
  attachLiveSession(session());
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "t1", pane_id: paneIds[0] ?? "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/d" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "demo" }],
    panes: paneIds.map((id) => ({ pane_id: id, workspace_id: "w1", tab_id: "t1", cwd: "/d", agent: "codex", agent_status: "idle" as const })),
  });
}

/** Reset to the original boot/home/null baseline (named domain actions). */
function resetOwnershipBaseline(): void {
  publishAllDomains();
  setPhase("boot");
  setScreen("home");
  setComputersFrom("home");
  setCredential(null);
  setComputers([]);
  setAddingComputer(false);
  setOperationBusy(false);
  setTermFontPx(12);
  replaceAgentsFromSnapshot({ panes: [] });
  selectPane("");
  attachLiveSession(null);
  setAgentChat(false);
  setFullTerminal(false);
  clearNotice();
  setListGroup("flat");
  setListGroupCollapsed({});
  setBoardReturn(false);
  setNetworkOnline(true);
  setTermSelect(false);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  registerSessionOwnerPreparer(null);
  if (isAppMounted()) act(() => { unmountApp(); });
  const leftover = appHost();
  if (leftover) releaseAppHost(leftover);
  resetCommitState();
  resetLayout();
  resetFrame();
  resetOwnershipBaseline();
  publishAllDomains();
  resetCommitState();
});

afterEach(() => {
  registerSessionOwnerPreparer(null);
  if (applicationIsRunning()) act(() => { stopApplication(); });
  if (isAppMounted()) act(() => { unmountApp(); });
  const active = appHost();
  if (active) releaseAppHost(active);
  resetCommitState();
  resetFrame();
  resetLayout();
  clearShell();
  flushNotifications();
  setTermFontPx(12);
});

describe("preparation settles before observers", () => {
  test("a preparer-induced pane transition reaches the frame before any session notification", async () => {
    const { sessionStore } = await import("../features/session/session-store");
    liveChatScene(["p1","p2"]);
    publishAllDomains();
    act(() => { mountApp(); });
    const seen: Array<{ paneId: string; bound: string | undefined }> = [];
    const release = sessionStore.subscribe(() => {
      seen.push({ paneId: sessionStore.get().paneId, bound: getAppFrame().session?.paneId });
    });
    let entered = false;
    registerSessionOwnerPreparer(() => {
      if (!entered) {
        entered = true;
        selectPane("p2");
      }
    });
    await act(async () => { commitApp(); });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((item) => item.paneId === item.bound)).toBeTrue();
    expect(getAppFrame().session?.paneId).toBe("p2");
    release();
  });

  test("first mount drains a composition requested by the owner preparer into its frame", async () => {
    liveChatScene();
    publishAllDomains();
    let entered = false;
    registerSessionOwnerPreparer(() => {
      if (!entered) {
        entered = true;
        setScreen("settings");
      }
    });
    await act(async () => { mountApp(); });
    await Promise.resolve();
    expect(navigationStore.get().screen).toBe("settings");
    expect(getAppFrame().layout?.mode).toBe("settings");
    expect(publishedLayout()?.mode).toBe("settings");
  });

  test("typed pane reset that changes composition prepares the new session kind", async () => {
    liveChatScene();
    publishAllDomains();
    const prepared: string[] = [];
    registerSessionOwnerPreparer((binding) => { prepared.push(binding.kind); });
    act(() => { mountApp(); });
    expect(prepared).toEqual(["chat"]);
    await act(async () => { resetPaneView(); });
    expect(getAppFrame().layout?.mode).toBe("pane");
    expect(getAppFrame().session?.kind).toBe("guided");
    expect(prepared).toEqual(["chat", "guided"]);
  });

  test("typed shell-only changes preserve a prepared session owner without consuming it again", async () => {
    liveChatScene();
    publishAllDomains();
    const prepared: string[] = [];
    registerSessionOwnerPreparer((binding) => { prepared.push(binding.kind); });
    act(() => { mountApp(); });
    const binding = getAppFrame().session;
    await act(async () => { setTermFontPx(17); });
    expect(prepared).toEqual(["chat"]);
    expect(getAppFrame().session).toEqual(binding);
    expect(getAppFrame().layout?.termFontPx).toBe(17);
  });

  test("a prepare-time ordinary shell action reaches the initial frame before publication", async () => {
    liveChatScene();
    publishAllDomains();
    let calls = 0;
    registerSessionOwnerPreparer(() => {
      calls += 1;
      setTermFontPx(17);
    });
    const seen: Array<{ font: number | undefined; shell: string }> = [];
    const release = frameStore.subscribe(() => {
      seen.push({
        font: getAppFrame().layout?.termFontPx,
        shell: appRoot().style.getPropertyValue("--term-fs"),
      });
    });
    await act(async () => { mountApp(); });
    expect(calls).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((item) => item.shell === `${item.font}px`)).toBeTrue();
    expect(getAppFrame().layout?.termFontPx).toBe(17);
    expect(publishedLayout()?.termFontPx).toBe(17);
    release();
  });

  test("a finite multi-step owner preparation converges before all observers", async () => {
    liveChatScene(["p1","p2","p3"]);
    publishAllDomains();
    const prepared: string[] = [];
    registerSessionOwnerPreparer((binding) => {
      prepared.push(binding.paneId);
      if (binding.paneId === "p1") selectPane("p2");
      else if (binding.paneId === "p2") selectPane("p3");
    });
    const seen: Array<{ pane: string; frame: string | undefined }> = [];
    const release = sessionStore.subscribe(() => {
      seen.push({ pane: sessionStore.get().paneId, frame: getAppFrame().session?.paneId });
    });
    await act(async () => { mountApp(); });
    expect(prepared).toEqual(["p1", "p2", "p3"]);
    expect(seen).toEqual([{ pane: "p3", frame: "p3" }]);
    expect(isCommitting()).toBeFalse();
    expect(batching()).toBeFalse();
    release();
  });

  test("typed reset composition is coherent at the domain notification", async () => {
    liveChatScene();
    publishAllDomains();
    await act(async () => { mountApp(); });
    const seen: Array<{ chat: boolean; mode: string | undefined; kind: string | undefined }> = [];
    const release = sessionStore.subscribe(() => {
      seen.push({
        chat: sessionStore.get().agentChat,
        mode: getAppFrame().layout?.mode,
        kind: getAppFrame().session?.kind,
      });
    });
    await act(async () => { resetPaneView(); });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((item) => item.chat ? item.kind === "chat" : item.kind === "guided")).toBeTrue();
    expect(getAppFrame().session?.kind).toBe("guided");
    release();
  });

  test("resetPaneView publishes session, compose and chat only when all three are retired", async () => {
    liveChatScene();
    publishAllDomains();
    applyTrace({ agentTraceItems: [{ type: "user", text: "old" }], agentTraceTail: 1 });
    setComposeDraft("old draft");
    await act(async () => { mountApp(); });
    const seen: Array<{ chat: boolean; draft: string; items: number; kind: string | undefined }> = [];
    const releases = [sessionStore, composeStore, chatStore].map((store) => store.subscribe(() => {
      seen.push({
        chat: sessionStore.get().agentChat,
        draft: composeStore.get().composeDraft,
        items: chatStore.get().agentTraceItems.length,
        kind: getAppFrame().session?.kind,
      });
    }));
    await act(async () => { resetPaneView(); });
    expect(seen.length).toBe(3);
    expect(seen.every((item) => item.chat === false && item.draft === "" && item.items === 0 && item.kind === "guided")).toBeTrue();
    for (const release of releases) release();
  });
});

describe("start failure teardown", () => {
  test("a throwing first mount does not leave the renderer or a running lifecycle", () => {
    liveChatScene();
    publishAllDomains();
    registerSessionOwnerPreparer(() => { throw new Error("preparer fails"); });
    let caught: unknown;
    try {
      act(() => { startApplication(); });
    } catch (error) {
      caught = error;
    }
    registerSessionOwnerPreparer(null);
    expect(caught).toBeInstanceOf(Error);
    expect(applicationIsRunning()).toBeFalse();
    expect(appHost()).toBeNull();
    expect(getAppFrame().layout).toBeNull();
  });
});

describe("cancelled composition holds", () => {
  test("cancelled queued composition releases the headless ordinary-write publication barrier", async () => {
    setNetworkOnline(true);
    publishAllDomains();
    await act(async () => { mountApp(); });
    await act(async () => {
      setPhase("connect");
      unmountApp();
    });
    expect(hasPendingComposition()).toBeFalse();
    let notices = 0;
    const release = connectionStore.subscribe(() => { notices += 1; });
    setNetworkOnline(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(connectionStore.get().networkOnline).toBeFalse();
    expect(notices).toBe(1);
    expect(connectionStore.isCompositionPending()).toBeFalse();
    release();
  });

  test("teardown publication cannot wipe a replacement app mounted by a domain subscriber", async () => {
    await act(async () => { mountApp(); });
    let remounted = false;
    const release = connectionStore.subscribe(() => {
      if (!remounted && !appHost()) {
        remounted = true;
        mountApp();
      }
    });
    await act(async () => {
      setPhase("connect");
      unmountApp();
    });
    expect(remounted).toBeTrue();
    expect(isAppMounted()).toBeTrue();
    expect(appHost()).not.toBeNull();
    expect(getAppFrame().layout?.mode).toBe("connect");
    expect(publishedLayout()?.mode).toBe("connect");
    release();
  });

  test("teardown frame publication cannot wipe a replacement mounted by that subscriber", async () => {
    await act(async () => { setPhase("connect"); mountApp(); });
    let remounted = false;
    const release = frameStore.subscribe(() => {
      if (!remounted && !appHost() && getAppFrame().layout === null) {
        remounted = true;
        mountApp();
      }
    });
    await act(async () => { unmountApp(); });
    expect(remounted).toBeTrue();
    expect(isAppMounted()).toBeTrue();
    expect(getAppFrame().layout?.mode).toBe("connect");
    expect(publishedLayout()?.mode).toBe("connect");
    expect(appRoot().style.getPropertyValue("--term-fs")).toBe("12px");
    release();
  });

  test("teardown layout publication cannot wipe a replacement mounted by that subscriber", async () => {
    await act(async () => { setPhase("connect"); mountApp(); });
    let remounted = false;
    const release = layoutStore.subscribe(() => {
      if (!remounted && !appHost() && publishedLayout() === null) {
        remounted = true;
        mountApp();
      }
    });
    await act(async () => { unmountApp(); });
    expect(remounted).toBeTrue();
    expect(isAppMounted()).toBeTrue();
    expect(getAppFrame().layout?.mode).toBe("connect");
    expect(publishedLayout()?.mode).toBe("connect");
    expect(appRoot().style.getPropertyValue("--term-fs")).toBe("12px");
    release();
  });
});

describe("layout ownership", () => {
  test("public live-layout read cannot give a caller authority to mutate future snapshots", () => {
    refreshPublishedLayout();
    const before = publishedLayout();
    const readValue = getLayout();
    try {
      (readValue as { termFontPx: number }).termFontPx = 999;
      (readValue as { shell: { booting: boolean } }).shell.booting = false;
    } catch {
      /* frozen */
    }
    layoutStore.publish();
    expect(publishedLayout()?.termFontPx).toBe(before?.termFontPx);
    expect(publishedLayout()?.shell.booting).toBe(before?.shell.booting);
  });

  test("refresh result and follower callback cannot retain writable canonical data", () => {
    for (const route of ["refresh-result", "follower-callback"] as const) {
      let retained: ReturnType<typeof publishedLayout> | undefined;
      if (route === "refresh-result") {
        retained = refreshPublishedLayout().layout;
      } else {
        refreshPublishedLayout();
        const stop = followLayoutInputs((layout) => { retained = layout; });
        setTermFontPx(17);
        stop();
      }
      const before = publishedLayout();
      try {
        (retained as { termFontPx: number }).termFontPx = 999;
        (retained as { shell: { booting: boolean } }).shell.booting = false;
      } catch {
        /* frozen */
      }
      layoutStore.publish();
      expect(publishedLayout()?.termFontPx).toBe(before?.termFontPx);
      expect(publishedLayout()?.shell.booting).toBe(before?.shell.booting);
    }
  });

  test("release returned by old layout follower cannot tear down its replacement", () => {
    refreshPublishedLayout();
    let a = 0;
    let b = 0;
    const oldStop = followLayoutInputs(() => { a += 1; });
    const newStop = followLayoutInputs(() => { b += 1; });
    oldStop();
    setTermFontPx(17);
    expect(b).toBe(1);
    expect(a).toBe(0);
    expect(publishedLayout()?.termFontPx).toBe(17);
    newStop();
  });

  test("typed layout frame publication applies its shell before frame observers run", async () => {
    await act(async () => { mountApp(); });
    const seen: Array<{ font: number | undefined; shell: string }> = [];
    const release = frameStore.subscribe(() => {
      seen.push({
        font: getAppFrame().layout?.termFontPx,
        shell: appRoot().style.getPropertyValue("--term-fs"),
      });
    });
    await act(async () => { setTermFontPx(17); });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((item) => item.shell === `${item.font}px`)).toBeTrue();
    release();
  });
});
