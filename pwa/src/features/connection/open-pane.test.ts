import { afterEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { composeStore, setComposeDraft } from "../session/compose-store";
import { chatStore } from "../session/chat/trace-store";
import { attachLiveSession, currentDaemonId, setCredential } from "../computers/catalog-store";
import { setPhase } from "./connection-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { openPaneId, selectPane, sessionStore } from "../session/session-store";
import { preferencesStore } from "../settings/preferences-store";
import { readStoredDraft, writeStoredDraft } from "../session/drafts/state-drafts";
import { openPaneWithOwner, type OpenPanePorts } from "./open-pane";
import { resetGenerationsForTests } from "./generations";
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
