import { afterEach, describe, expect, test } from "bun:test";
import "../../test-support/boot-dom";

const { computersFrom, currentScreen, goToScreen, leavePaneScreen, navigationStore, setComputersFrom, setScreen } = await import("./navigation-store");
const { boardReturn, boardStore, setBoardReturn } = await import("../features/board/layout-store");
const { resetPaneView, selectPane, sessionStore, setAgentChat, setFullTerminal, setTermSelect, applyPaneRead, setPaneFollow, setPaneUnread, setPaneRow } =
  await import("../features/session/session-store");
const { adoptPaneCompose, composeStore, setComposeDraft, setComposeFocused, setComposeLive } = await import("../features/session/compose-store");
const { chatStore, resetTrace, setPendingTurn, setTraceBusy, applyTrace } = await import("../features/session/chat/trace-store");
const { defaultComposeLive, keysExpanded, padKind, setKeysExpanded, setPadKind, setPaneComposeLive } = await import("../features/settings/preferences-store");
const { takeTransition } = await import("./transition");

const restore = {
  screen: currentScreen(),
  computersFrom: computersFrom(),
  boardReturn: boardReturn(),
};

afterEach(() => {
  takeTransition();
  setScreen(restore.screen);
  setComputersFrom(restore.computersFrom);
  setBoardReturn(restore.boardReturn);
});

describe("navigation domain", () => {
  test("a screen change declares the transition its depth relation implies", () => {
    setScreen("home");
    goToScreen("pane", { paneId: "p1" });
    expect(navigationStore.get().screen).toBe("pane");
    expect(takeTransition()).toBe("push");

    goToScreen("workspace");
    expect(takeTransition()).toBe("push");

    goToScreen("home");
    expect(takeTransition()).toBe("pop");

    // A sideways move cross-fades; a repeated screen animates nothing.
    goToScreen("settings");
    expect(takeTransition()).toBe("fade");
    let publishes = 0;
    const release = navigationStore.subscribe(() => { publishes += 1; });
    goToScreen("settings");
    expect(publishes).toBe(0);
    expect(takeTransition()).toBe("none");
    release();
  });

  test("an explicit transition and a plain move are both available to callers", () => {
    setScreen("home");
    goToScreen("board", { transition: "expand", paneId: "p7" });
    expect(takeTransition()).toBe("expand");

    goToScreen("home", { plain: true });
    expect(navigationStore.get().screen).toBe("home");
    expect(takeTransition()).toBe("none");

    setScreen("pane");
    expect(takeTransition()).toBe("none");
    expect(navigationStore.get().screen).toBe("pane");
  });

  test("leaving the pane returns to the board opening, otherwise to the list", () => {
    setScreen("pane");
    setBoardReturn(true);
    leavePaneScreen();
    expect(navigationStore.get().screen).toBe("board");
    expect(boardStore.get().boardReturn).toBeFalse();

    setScreen("pane");
    leavePaneScreen();
    expect(navigationStore.get().screen).toBe("home");
  });

  test("headless leavePaneScreen publishes navigation and board return together", () => {
    setScreen("pane");
    setBoardReturn(true);
    const seen: Array<{ screen: string; boardReturn: boolean }> = [];
    const release = navigationStore.subscribe(() => {
      seen.push({ screen: navigationStore.get().screen, boardReturn: boardStore.get().boardReturn });
    });
    leavePaneScreen();
    release();
    expect(seen).toEqual([{ screen: "board", boardReturn: false }]);
  });
});

describe("pane view reset", () => {
  test("resetting a pane clears the buffer, compose field and transcript together", () => {
    selectPane("p1");
    setFullTerminal(true);
    setAgentChat(true);
    setTermSelect(true);
    setComposeDraft("draft");
    setComposeFocused(true);
    setComposeLive(true);
    setTraceBusy(true);
    setPendingTurn("hello", []);
    applyTrace({ agentTraceLoadState: "ready" });
    applyPaneRead("output", "h");
    setPaneFollow(false);
    setPaneUnread(true);
    setPaneRow(3);
    // Non-default keypad choices, so "they survive" is a real assertion.
    setKeysExpanded(true);
    setPadKind("slash");

    resetPaneView();

    expect(sessionStore.get().paneText).toBe("");
    expect(sessionStore.get().paneFollow).toBeTrue();
    expect(sessionStore.get().paneUnread).toBeFalse();
    expect(sessionStore.get().paneRow).toBeNull();
    expect(sessionStore.get().termSelect).toBeFalse();
    expect(sessionStore.get().fullTerminal).toBeFalse();
    expect(sessionStore.get().agentChat).toBeFalse();
    expect(composeStore.get().composeDraft).toBe("");
    expect(composeStore.get().composeFocused).toBeFalse();
    expect(chatStore.get().agentTraceItems).toEqual([]);
    expect(chatStore.get().agentTraceLoadState).toBe("cold");
    expect(chatStore.get().agentTracePending).toBe("");
    expect(chatStore.get().agentTraceBusy).toBeFalse();

    // The keypad and the pane's own input choice survive a pane switch.
    expect(composeStore.get().composeLive).toBeTrue();
    expect(keysExpanded()).toBeTrue();
    expect(padKind()).toBe("slash");

    setKeysExpanded(false);
    setPadKind("keys");
  });

  test("a reset publishes the three domains it owns once each", () => {
    const counts = { session: 0, compose: 0, chat: 0 };
    const releases = [
      sessionStore.subscribe(() => { counts.session += 1; }),
      composeStore.subscribe(() => { counts.compose += 1; }),
      chatStore.subscribe(() => { counts.chat += 1; }),
    ];
    counts.session = 0;
    counts.compose = 0;
    counts.chat = 0;
    resetPaneView();
    expect(counts).toEqual({ session: 1, compose: 1, chat: 1 });
    for (const release of releases) release();
  });

  test("opening a pane adopts that pane's stored input choice", () => {
    setPaneComposeLive("p2", true);
    selectPane("p2");
    adoptPaneCompose("p2");
    expect(composeStore.get().composeLive).toBeTrue();

    selectPane("p3");
    adoptPaneCompose("p3");
    expect(composeStore.get().composeLive).toBe(defaultComposeLive());

    // The keypad is a preference, not a per-pane view mode: adopting a pane's
    // input choice leaves it alone.
    setKeysExpanded(true);
    setPadKind("slash");
    adoptPaneCompose("p3");
    expect(keysExpanded()).toBeTrue();
    expect(padKind()).toBe("slash");
    setKeysExpanded(false);
    setPadKind("keys");
  });
});
