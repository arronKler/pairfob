import { afterEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { composeStore, setComposeDraft } from "../session/compose-store";
import { chatStore } from "../session/chat/trace-store";
import { attachLiveSession, currentDaemonId, setCredential } from "../computers/catalog-store";
import { setPhase } from "./connection-store";
import { adoptPreparedFrame, resetFrame } from "../../app/frame";
import { computeLayout } from "../../app/layout";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { applySnapshot, dashboardStore, resetDashboard } from "../dashboard/catalog-store";
import { openPaneId, selectPane, sessionStore, setAgentChat, setFullTerminal } from "../session/session-store";
import { paneTermMode, preferencesStore, setPaneTermMode } from "../settings/preferences-store";
import { readStoredDraft, writeStoredDraft } from "../session/drafts/state-drafts";
import { openPaneWithOwner, type OpenPanePorts } from "./open-pane";
import { nextPaneNavigation, paneNavigationIsCurrent, resetGenerationsForTests } from "./generations";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { PairResult } from "../../lib/protocol/client";

function credential(): PairResult {
  return {
    deviceId: "phone_1",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: "d_aaaaaaaaaaaaaaaaaaaa",
    fp: "fp_1",
    relayOrigin: "https://pairfob.com",
    label: "test",
    createdAt: 1,
  };
}

function ports(over: Partial<OpenPanePorts> = {}): OpenPanePorts {
  const live = { isConnected: () => true } as LiveSession;
  return {
    currentLive: () => live,
    currentIncarnation: () => 1,
    parkComposeView: () => undefined,
    dropQueuedKeys: () => undefined,
    disposeGuidedScroll: () => undefined,
    leaveFullTerminal: async () => null,
    restoreAgentTrace: () => undefined,
    canEnterAgentChat: () => false,
    resolvedTermMode: () => "guided",
    queuedKind: () => "none",
    nextTransition: () => undefined,
    transitionFor: () => "push",
    currentScreen: () => "home",
    isFullTerminal: () => false,
    findAgent: () => undefined,
    commitView: () => undefined,
    refreshPane: async () => undefined,
    ...over,
  };
}

afterEach(() => {
  resetGenerationsForTests();
  resetFrame();
});

describe("openPane atomic transition", () => {
  test("a destination draft is published once, never as an empty intermediate", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    setCredential(null);
    attachLiveSession({ isConnected: () => true } as LiveSession);
    selectPane("pA");
    setScreen("pane");
    setComposeDraft("alpha");
    writeStoredDraft({ daemonId: currentDaemonId(), paneId: "pB", mode: "guided" }, { text: "bravo", revision: 1 });
    expect(readStoredDraft({ daemonId: currentDaemonId(), paneId: "pB", mode: "guided" }).text).toBe("bravo");
    const seen: string[] = [];
    const stop = composeStore.subscribe(() => {
      seen.push(composeStore.get().composeDraft);
    });
    await openPaneWithOwner("pB", ports({
      currentIncarnation: () => 2,
    }));
    stop();
    expect(composeStore.get().composeDraft).toBe("bravo");
    expect(seen.includes("")).toBe(false);
    expect(seen.at(-1)).toBe("bravo");
  });

  test("a subscriber navigation during paint skips the pane read", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    let reads = 0;
    let incarnation = 4;
    const nav = await openPaneWithOwner("pZ", ports({
      currentLive: () => session,
      currentIncarnation: () => incarnation,
      commitView: () => {
        incarnation += 1;
      },
      refreshPane: async () => {
        reads += 1;
      },
    }));
    expect(nav).toBeNull();
    expect(reads).toBe(0);
  });

  test("a deferred (shared-transition) commit is awaited before the pane is read", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    const order: string[] = [];
    let commit!: () => void;
    const pending = openPaneWithOwner("pD", ports({
      currentLive: () => session,
      currentScreen: () => "pane",
      commitView: () => new Promise<void>((resolve) => {
        order.push("capture");
        commit = () => { order.push("commit"); resolve(); };
      }),
      refreshPane: async () => { order.push("read"); },
    }));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(order).toEqual(["capture"]);
    commit();
    const nav = await pending;
    expect(order).toEqual(["capture", "commit", "read"]);
    expect(nav?.isCurrent()).toBeTrue();
  });

  test("a subscriber completing a newer openPane during rememberPane wins", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    setScreen("pane");
    let nested = false;
    let nestedDone: Promise<unknown> = Promise.resolve();
    const stop = preferencesStore.subscribe(() => {
      if (nested) return;
      nested = true;
      nestedDone = openPaneWithOwner("p3", ports({ currentLive: () => session }));
    });
    const nav = await openPaneWithOwner("p2", ports({ currentLive: () => session }));
    await nestedDone;
    stop();
    expect(nav).toBeNull();
    expect(openPaneId()).toBe("p3");
  });

  test("a subscriber navigating home during the batch does not recapture the old route", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    setScreen("pane");
    let reads = 0;
    let navigated = false;
    const stop = sessionStore.subscribe(() => {
      if (navigated) return;
      if (sessionStore.get().paneId !== "p2") return;
      navigated = true;
      setScreen("home");
    });
    const nav = await openPaneWithOwner("p2", ports({
      currentLive: () => session,
      refreshPane: async () => {
        reads += 1;
      },
    }));
    stop();
    expect(nav).toBeNull();
    expect(reads).toBe(0);
    expect(currentScreen()).toBe("home");
  });

  test("a normal navigation from home commits the destination and refreshes exactly once", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    setScreen("home");
    let refreshes = 0;
    let paints = 0;
    const nav = await openPaneWithOwner("p2", ports({
      currentLive: () => session,
      currentScreen: () => currentScreen(),
      refreshPane: async () => {
        refreshes += 1;
      },
      commitView: () => {
        paints += 1;
      },
    }));
    expect(nav).not.toBeNull();
    expect(nav?.isCurrent()).toBeTrue();
    expect(openPaneId()).toBe("p2");
    expect(currentScreen()).toBe("pane");
    expect(refreshes).toBe(1);
    expect(paints).toBe(1);
  });

  test("a normal navigation between panes commits the destination and refreshes exactly once", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    selectPane("p1");
    setScreen("pane");
    let refreshes = 0;
    let paints = 0;
    const nav = await openPaneWithOwner("p2", ports({
      currentLive: () => session,
      currentScreen: () => currentScreen(),
      refreshPane: async () => {
        refreshes += 1;
      },
      commitView: () => {
        paints += 1;
      },
    }));
    expect(nav).not.toBeNull();
    expect(nav?.isCurrent()).toBeTrue();
    expect(openPaneId()).toBe("p2");
    expect(refreshes).toBe(1);
    expect(paints).toBe(1);
  });

  test("an agent preference that cannot enter chat restores the guided draft", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    setCredential(credential());
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    setScreen("pane");
    writeStoredDraft({ daemonId: currentDaemonId(), paneId: "p9", mode: "guided" }, { text: "guided-text", revision: 1 });
    writeStoredDraft({ daemonId: currentDaemonId(), paneId: "p9", mode: "agent" }, { text: "agent-text", revision: 1 });
    await openPaneWithOwner("p9", ports({
      currentLive: () => session,
      resolvedTermMode: () => "agent",
      canEnterAgentChat: () => false,
    }));
    expect(composeStore.get().composeDraft).toBe("guided-text");
    expect(sessionStore.get().agentChat).toBe(false);
  });

  test("an agent draft restores its stored recovery error", async () => {
    await resetBoardTestDOM();
    setPhase("live");
    setCredential(credential());
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    setScreen("pane");
    writeStoredDraft(
      { daemonId: currentDaemonId(), paneId: "p9", mode: "agent" },
      { text: "RETRY", error: "retry error", revision: 1 },
    );
    await openPaneWithOwner("p9", ports({
      currentLive: () => session,
      resolvedTermMode: () => "agent",
      canEnterAgentChat: () => true,
    }));
    expect(composeStore.get().composeDraft).toBe("RETRY");
    expect(chatStore.get().agentTraceNote).toBe("retry error");
  });
});

/**
 * The committed frame shows `paneId` under `session`, the way a commit on the
 * pane screen leaves it: beside the list, or on a phone's own pane screen.
 */
function display(
  paneId: string,
  session: LiveSession,
  kind: "guided" | "chat" | "terminal" = "guided",
  incarnation = 1,
  desk = true,
): void {
  selectPane(paneId);
  setScreen("pane");
  setFullTerminal(kind === "terminal");
  setAgentChat(kind === "chat");
  adoptPreparedFrame({
    layout: computeLayout({
      phase: "live", screen: "pane", fullTerminal: kind === "terminal", agentChat: kind === "chat", desk,
      hasSelectedPane: true, termFontPx: 12, operationBusy: false,
    }),
    scroll: null,
    session: { kind, paneId, incarnation },
    sessionOwner: session,
  });
}

/** Ports that count every step an open takes, and read the real screen. */
function counting(session: LiveSession, over: Partial<OpenPanePorts> = {}) {
  const steps: string[] = [];
  const step = (name: string) => () => { steps.push(name); };
  return {
    steps,
    ports: ports({
      currentLive: () => session,
      currentScreen: () => currentScreen(),
      isFullTerminal: () => sessionStore.get().fullTerminal,
      parkComposeView: step("park"),
      dropQueuedKeys: step("drop keys"),
      disposeGuidedScroll: step("dispose scroll"),
      leaveFullTerminal: async () => { steps.push("leave terminal"); return { from: 1, to: 1 }; },
      restoreAgentTrace: step("restore trace"),
      commitView: step("commit"),
      refreshPane: async () => { steps.push("read"); },
      ...over,
    }),
  };
}

describe("choosing the pane that is already on screen beside the list", () => {
  async function boot(): Promise<LiveSession> {
    await resetBoardTestDOM();
    setPhase("live");
    setCredential(credential());
    const session = { isConnected: () => true } as LiveSession;
    attachLiveSession(session);
    return session;
  }

  test("a complete terminal is not left, re-resolved or reopened, and its draft stays", async () => {
    const session = await boot();
    display("pA", session, "terminal");
    // The stored mode differs from the one on screen: a second open would drop to it.
    setPaneTermMode("pA", "guided");
    setComposeDraft("half a command");
    writeStoredDraft({ daemonId: currentDaemonId(), paneId: "pA", mode: "guided" }, { text: "stored", revision: 1 });
    const { steps, ports: counted } = counting(session, { resolvedTermMode: () => "guided" });

    const nav = await openPaneWithOwner("pA", counted);

    expect(steps).toEqual([]);
    expect(sessionStore.get().fullTerminal).toBeTrue();
    expect(sessionStore.get().agentChat).toBeFalse();
    expect(paneTermMode("pA")).toBe("guided");
    expect(composeStore.get().composeDraft).toBe("half a command");
    expect(openPaneId()).toBe("pA");
    expect(currentScreen()).toBe("pane");
    // The caller still gets an owner for the pane it asked for.
    expect(nav?.isCurrent()).toBeTrue();
    expect(nav?.scope.paneId).toBe("pA");
    expect(nav?.incarnation).toBe(1);
  });

  test("a chat stays a chat and a guided session stays guided", async () => {
    const session = await boot();
    display("pA", session, "chat");
    setComposeDraft("a question");
    const chat = counting(session, { resolvedTermMode: () => "guided" });
    await openPaneWithOwner("pA", chat.ports);
    expect(chat.steps).toEqual([]);
    expect(sessionStore.get().agentChat).toBeTrue();
    expect(composeStore.get().composeDraft).toBe("a question");

    display("pA", session, "guided");
    const guided = counting(session, { resolvedTermMode: () => "full" });
    await openPaneWithOwner("pA", guided.ports);
    expect(guided.steps).toEqual([]);
    expect(sessionStore.get().fullTerminal).toBeFalse();
  });

  test("it supersedes no navigation that is still finishing", async () => {
    const session = await boot();
    display("pA", session);
    const inFlight = nextPaneNavigation();
    await openPaneWithOwner("pA", counting(session).ports);
    expect(paneNavigationIsCurrent(inFlight)).toBeTrue();
  });

  test("the row still acknowledges an unread completion", async () => {
    const session = await boot();
    resetDashboard();
    applySnapshot({
      panes: [{ pane_id: "pA", workspace_id: "w1", tab_id: "t1", agent: "codex", agent_status: "done", state_change_seq: 1 }],
    });
    expect(dashboardStore.get().agents[0]?.status).toBe("done");
    display("pA", session, "terminal");

    const { steps, ports: counted } = counting(session);
    await openPaneWithOwner("pA", counted);

    expect(dashboardStore.get().agents[0]?.status).toBe("idle");
    expect(steps).toEqual([]);
    resetDashboard();
  });

  test("its navigation ends when the reader goes somewhere else", async () => {
    const session = await boot();
    display("pA", session);
    const nav = await openPaneWithOwner("pA", counting(session).ports);
    expect(nav?.isCurrent()).toBeTrue();
    setScreen("home");
    expect(nav?.isCurrent()).toBeFalse();
  });

  test("another pane runs the whole open, leaving the terminal first", async () => {
    const session = await boot();
    display("pA", session, "terminal");
    const { steps, ports: counted } = counting(session);

    const nav = await openPaneWithOwner("pB", counted);

    expect(steps).toEqual(["park", "drop keys", "dispose scroll", "leave terminal", "restore trace", "commit", "read"]);
    expect(openPaneId()).toBe("pB");
    expect(sessionStore.get().fullTerminal).toBeFalse();
    expect(nav?.isCurrent()).toBeTrue();
  });

  test("the same pane chosen while another page fills the column opens as it always did", async () => {
    const session = await boot();
    display("pA", session, "terminal");
    // Settings took the main column; the terminal is still the pane's mode.
    setScreen("settings");
    const { steps, ports: counted } = counting(session, { resolvedTermMode: () => "full" });

    await openPaneWithOwner("pA", counted);

    expect(steps).toEqual(["park", "drop keys", "dispose scroll", "leave terminal", "restore trace", "commit", "read"]);
    expect(currentScreen()).toBe("pane");
  });

  test("a phone, whose list is a screen of its own, opens as it always did", async () => {
    const session = await boot();
    // From the list: the pane was left for it, and the list still remembers it.
    display("pA", session, "guided", 1, false);
    setScreen("home");
    const fromList = counting(session);
    await openPaneWithOwner("pA", fromList.ports);
    expect(fromList.steps).toEqual(["park", "drop keys", "dispose scroll", "restore trace", "commit", "read"]);
    expect(currentScreen()).toBe("pane");

    // And asked for again while it is the whole screen (a notification for it).
    display("pA", session, "terminal", 1, false);
    const onScreen = counting(session, { resolvedTermMode: () => "full" });
    await openPaneWithOwner("pA", onScreen.ports);
    expect(onScreen.steps).toEqual(["park", "drop keys", "dispose scroll", "leave terminal", "restore trace", "commit", "read"]);
  });

  test("a frame from another live session or an older view is not this pane on screen", async () => {
    const session = await boot();
    display("pA", { isConnected: () => true } as LiveSession);
    const stale = counting(session);
    await openPaneWithOwner("pA", stale.ports);
    expect(stale.steps).toContain("commit");

    display("pA", session, "guided", 1);
    const moved = counting(session, { currentIncarnation: () => 2 });
    await openPaneWithOwner("pA", moved.ports);
    expect(moved.steps).toContain("commit");

    // And a pane selected with nothing committed for it yet.
    resetFrame();
    selectPane("pA");
    setScreen("pane");
    const unpainted = counting(session);
    await openPaneWithOwner("pA", unpainted.ports);
    expect(unpainted.steps).toContain("commit");
  });
});
