import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../test-support/dom";
import type { LiveSession } from "../lib/protocol/client";

const { adoptPreparedFrame, frameStore, getAppFrame, registerSessionOwnerPreparer } = await import("./frame");
const { prepareFrame } = await import("./frame-prepare");
const { computeLayout } = await import("./layout");
const { publishAllDomains } = await import("./domain-publication");
const { readHerdAttention } = await import("../pages/home/herd-bridge");
const { happy } = await import("../../test-support/dom");
const { setPhase } = await import("../features/connection/connection-store");
const { setScreen } = await import("./navigation-store");
const { attachLiveSession, liveSession } = await import("../features/computers/catalog-store");
const { replaceAgentsFromSnapshot } = await import("../features/dashboard/catalog-store");
const { selectPane, setAgentChat, setFullTerminal } = await import("../features/session/session-store");
const { setListGroup, termFontPx } = await import("../features/settings/preferences-store");

function session(): LiveSession {
  return { isConnected: () => true } as LiveSession;
}

const demoCard = (paneId: string, cwd: string) => ({
  focused: { workspace_id: "w1", tab_id: "t1", pane_id: paneId },
  workspaces: [{ workspace_id: "w1", label: cwd.slice(1), cwd }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: cwd.slice(1) }],
  panes: [{ pane_id: paneId, workspace_id: "w1", tab_id: "t1", cwd, agent: "codex", agent_status: "idle" }],
});

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setAgentChat(false);
  setFullTerminal(false);
  setListGroup("flat");
  replaceAgentsFromSnapshot(demoCard("p1", "/demo"));
  attachLiveSession(session());
  publishAllDomains();
  prepareFrame();
});

afterEach(() => {
  registerSessionOwnerPreparer(null);
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
  setPhase("resuming");
  setAgentChat(false);
  publishAllDomains();
});

describe("the frame binds the displayed session before the page renders", () => {
  test("the phone guided pane binds its owner, pane and view incarnation", () => {
    const frame = prepareFrame();
    expect(frame.layout?.mode).toBe("pane");
    expect(frame.session?.kind).toBe("guided");
    expect(frame.session?.paneId).toBe("p1");
    expect(typeof frame.session?.incarnation).toBe("number");
    expect(frame.sessionOwner).toBe(liveSession());
    expect(frame.scroll).not.toBeNull();
  });

  test("the phone chat page binds the same owner contract", () => {
    setAgentChat(true);
    const frame = prepareFrame();
    expect(frame.layout?.mode).toBe("chat");
    expect(frame.session?.kind).toBe("chat");
    expect(frame.session?.paneId).toBe("p1");
    expect(frame.sessionOwner).toBe(liveSession());
    // The chat page owns its stream scroll; no terminal snapshot is prepared.
    expect(frame.scroll).toBeNull();
  });

  test("the desktop chat column is bound too, not only the guided one", () => {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    setAgentChat(true);
    const frame = prepareFrame();
    expect(frame.layout?.mode).toBe("desk");
    expect(frame.layout?.deskChild).toBe("chat");
    expect(frame.session?.kind).toBe("chat");
    expect(frame.session?.paneId).toBe("p1");
    expect(frame.sessionOwner).toBe(liveSession());
    expect(frame.scroll).toBeNull();
  });

  test("the desktop guided column keeps its scroll snapshot and owner", () => {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    const frame = prepareFrame();
    expect(frame.layout?.deskChild).toBe("session");
    expect(frame.session?.kind).toBe("guided");
    expect(frame.sessionOwner).toBe(liveSession());
    expect(frame.scroll).not.toBeNull();
  });

  test("a page without a session binds nothing and prepares no snapshot", () => {
    setScreen("settings");
    const frame = prepareFrame();
    expect(frame.layout?.mode).toBe("settings");
    expect(frame.session).toBeNull();
    expect(frame.sessionOwner).toBeNull();
    expect(frame.scroll).toBeNull();
  });

  test("the registered owner preparer runs for every session composition", () => {
    const prepared: Array<{ kind: string; paneId: string; owner: boolean }> = [];
    registerSessionOwnerPreparer((session, owner) => {
      prepared.push({ kind: session.kind, paneId: session.paneId, owner: owner === liveSession() });
    });
    try {
      prepareFrame();
      setAgentChat(true);
      prepareFrame();
      happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
      prepareFrame();
      setAgentChat(false);
      prepareFrame();
      setScreen("settings");
      prepareFrame();
    } finally {
      registerSessionOwnerPreparer(null);
    }
    // Phone guided, phone chat, desk chat, desk guided — and nothing for settings.
    expect(prepared).toEqual([
      { kind: "guided", paneId: "p1", owner: true },
      { kind: "chat", paneId: "p1", owner: true },
      { kind: "chat", paneId: "p1", owner: true },
      { kind: "guided", paneId: "p1", owner: true },
    ]);
  });

  test("switching panes rebinds instead of keeping the previous owner", () => {
    const first = prepareFrame();
    const owner = first.sessionOwner;
    selectPane("p2");
    replaceAgentsFromSnapshot(demoCard("p2", "/d"));
    attachLiveSession(session());
    const second = prepareFrame();
    expect(second.session?.paneId).toBe("p2");
    expect(second.sessionOwner).toBe(liveSession());
    expect(second.sessionOwner === owner).toBeFalse();
  });
});

describe("the frame publishes owned data immutably and handles by identity", () => {
  test("layout, scroll and binding are frozen; prepared handles keep identity", () => {
    const frame = prepareFrame();
    expect(Object.isFrozen(frame)).toBeTrue();
    expect(Object.isFrozen(frame.layout)).toBeTrue();
    expect(Object.isFrozen(frame.layout?.shell)).toBeTrue();
    expect(Object.isFrozen(frame.session)).toBeTrue();
    expect(Object.isFrozen(frame.scroll)).toBeTrue();
    // A home composition consumes herd attention once through the home bridge,
    // outside React; the frame itself carries no herd projection any more.
    setScreen("home");
    const home = prepareFrame();
    expect(home.session).toBeNull();
    expect(home.sessionOwner).toBeNull();
    expect(getAppFrame().sessionOwner).toBeNull();
    // A page with no session binds nothing, so no owner is handed to it.
    expect(getAppFrame().layout?.mode).toBe("home");
  });

  test("the layout matches the pure composition for the same domains", () => {
    const frame = prepareFrame();
    expect(frame.layout).toEqual(computeLayout({
      phase: "live", screen: "pane", fullTerminal: false, agentChat: false, desk: false,
      hasSelectedPane: true, termFontPx: termFontPx(), operationBusy: false,
    }));
  });

  test("a session preparer cannot retain a writable alias of the frame binding", () => {
    let retained: { paneId: string } | undefined;
    registerSessionOwnerPreparer((session) => {
      retained = session as { paneId: string };
    });
    try {
      prepareFrame();
      const initial = getAppFrame();
      expect(() => {
        retained!.paneId = "POISON";
      }).toThrow();
      expect(initial.session?.paneId).toBe("p1");
      frameStore.publish();
      expect(getAppFrame().session?.paneId).toBe("p1");
    } finally {
      registerSessionOwnerPreparer(null);
    }
  });

  test("adoptPreparedFrame detaches every plain metadata input and preserves live handle identity", () => {
    const handle = session();
    const input = {
      layout: computeLayout({
        phase: "live", screen: "pane", fullTerminal: false, agentChat: true, desk: false,
        hasSelectedPane: true, termFontPx: 12, operationBusy: false,
      }),
      session: { kind: "chat" as const, paneId: "p1", incarnation: 1 },
      sessionOwner: handle,
      scroll: { top: 12, left: 0, bottom: false },
    };
    const before = adoptPreparedFrame(input);
    let notices = 0;
    const release = frameStore.subscribe(() => { notices += 1; });
    input.layout.termFontPx = 999;
    input.session.paneId = "poison";
    input.scroll.top = 999;
    expect(notices).toBe(0);
    expect(before.session?.paneId).toBe("p1");
    expect(before.sessionOwner).toBe(handle);
    frameStore.publish();
    const after = getAppFrame();
    expect(after.session?.paneId).toBe("p1");
    expect(after.scroll?.top).toBe(12);
    expect(after.layout?.termFontPx).toBe(12);
    expect(after.sessionOwner).toBe(handle);
    release();
  });

  test("herd attention is consumed and frozen by the home bridge, never through the frame", () => {
    setScreen("home");
    const frame = prepareFrame();
    expect(frame.layout?.mode).toBe("home");
    const attention = readHerdAttention();
    expect(Object.isFrozen(attention)).toBeTrue();
    expect(Object.isFrozen(attention.completed)).toBeTrue();
    const original = attention.stagger;
    let notices = 0;
    const release = frameStore.subscribe(() => { notices += 1; });
    expect(() => {
      (attention as { stagger: boolean }).stagger = !original;
    }).toThrow();
    expect(() => {
      (attention.completed as string[]).push("EXTERNAL");
    }).toThrow();
    expect(attention.stagger).toBe(original);
    expect(attention.completed.includes("EXTERNAL")).toBeFalse();
    // The frame owns no herd projection for a reader to corrupt.
    expect("herdPaint" in frame).toBeFalse();
    expect("herdGroups" in frame).toBeFalse();
    expect(notices).toBe(0);
    release();
  });
});
