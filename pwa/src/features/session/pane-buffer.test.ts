import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { attachLiveSession, setCredential } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { PairResult } from "../../lib/protocol/client";
import { clearPaneBufferCache, rememberPaneBuffer, restorePaneBuffer } from "./pane-buffer";
import { applyPaneRead, paneLoaded, resetPaneView, selectPane, sessionStore } from "./session-store";

function credential(daemonId = "d_aaaaaaaaaaaaaaaaaaaa"): PairResult {
  return {
    deviceId: "phone_1",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId,
    fp: "fp_1",
    relayOrigin: "https://pairfob.com",
    label: "test",
    createdAt: 1,
  };
}

function session(): LiveSession {
  return { isConnected: () => true } as LiveSession;
}

/** A live computer whose runtime session reports the given panes. */
function liveScene(panes: Array<{ paneId: string; agentInstanceId?: string }>, runtimeSession = "rt_1"): void {
  setPhase("live");
  setCredential(credential());
  attachLiveSession(session());
  replaceAgentsFromSnapshot({
    session: runtimeSession,
    focused: { workspace_id: "w1", tab_id: "t1", pane_id: panes[0]?.paneId },
    workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/demo" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "demo" }],
    panes: panes.map((pane) => ({
      pane_id: pane.paneId,
      workspace_id: "w1",
      tab_id: "t1",
      agent: "codex",
      agent_status: "idle",
      agent_instance_id: pane.agentInstanceId ?? "inst_1",
    })),
  });
}

/** The state a visit starts from: the pane selected, its view cleared. */
function openVisiting(paneId: string): void {
  selectPane(paneId);
  resetPaneView();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearPaneBufferCache();
});

afterEach(() => {
  clearPaneBufferCache();
  resetPaneView();
  selectPane("");
  attachLiveSession(null);
  setCredential(null);
  replaceAgentsFromSnapshot({ panes: [] });
});

describe("pane buffer cache", () => {
  test("a read kept for one visit is painted on the next, before its own read", () => {
    liveScene([{ paneId: "p1" }]);
    openVisiting("p1");
    applyPaneRead("first visit screen", "h1");
    rememberPaneBuffer("p1", "first visit screen", "h1");

    openVisiting("p1");
    expect(paneLoaded()).toBeFalse();
    expect(restorePaneBuffer("p1")).toBeTrue();
    expect(paneLoaded()).toBeTrue();
    expect(sessionStore.get().paneText).toBe("first visit screen");
    expect(sessionStore.get().paneHash).toBe("h1");
  });

  test("with nothing kept the pane stays unloaded, so the visit reads it", () => {
    liveScene([{ paneId: "p1" }, { paneId: "p2" }]);
    openVisiting("p1");
    applyPaneRead("p1 screen", "h1");
    rememberPaneBuffer("p1", "p1 screen", "h1");

    openVisiting("p2");
    expect(restorePaneBuffer("p2")).toBeFalse();
    expect(paneLoaded()).toBeFalse();
    expect(sessionStore.get().paneText).toBe("");
  });

  test("a screen with no text is not kept: there is nothing to paint", () => {
    liveScene([{ paneId: "p1" }]);
    openVisiting("p1");
    rememberPaneBuffer("p1", "", "");
    expect(restorePaneBuffer("p1")).toBeFalse();
  });

  test("another occupant of the same pane id is not handed the old screen", () => {
    liveScene([{ paneId: "p1", agentInstanceId: "inst_1" }]);
    rememberPaneBuffer("p1", "old agent's screen", "h1");

    liveScene([{ paneId: "p1", agentInstanceId: "inst_2" }]);
    openVisiting("p1");
    expect(restorePaneBuffer("p1")).toBeFalse();
    expect(paneLoaded()).toBeFalse();
  });

  test("another runtime session of the same computer is not handed the old screen", () => {
    liveScene([{ paneId: "p1" }], "rt_1");
    rememberPaneBuffer("p1", "old session's screen", "h1");

    liveScene([{ paneId: "p1" }], "rt_2");
    openVisiting("p1");
    expect(restorePaneBuffer("p1")).toBeFalse();
  });

  test("another computer's pane id is not handed the old screen", () => {
    liveScene([{ paneId: "p1" }]);
    rememberPaneBuffer("p1", "this computer's screen", "h1");

    setCredential(credential("d_bbbbbbbbbbbbbbbbbbbb"));
    openVisiting("p1");
    expect(restorePaneBuffer("p1")).toBeFalse();
  });

  test("nothing is kept without a live session, which owns no screen", () => {
    liveScene([{ paneId: "p1" }]);
    attachLiveSession(null);
    rememberPaneBuffer("p1", "a screen from nowhere", "h1");
    attachLiveSession(session());
    expect(restorePaneBuffer("p1")).toBeFalse();
  });

  test("the cache is bounded and keeps the most recently used panes", () => {
    liveScene([{ paneId: "p1" }]);
    for (let i = 1; i <= 6; i += 1) rememberPaneBuffer(`pane_${i}`, `screen ${i}`, `h${i}`);
    // Touch the oldest so the next insertion evicts something else.
    expect(restorePaneBuffer("pane_1")).toBeTrue();
    rememberPaneBuffer("pane_7", "screen 7", "h7");

    const kept = ["pane_1", "pane_3", "pane_4", "pane_5", "pane_6", "pane_7"]
      .filter((paneId) => restorePaneBuffer(paneId));
    expect(kept).toEqual(["pane_1", "pane_3", "pane_4", "pane_5", "pane_6", "pane_7"]);
    expect(restorePaneBuffer("pane_2")).toBeFalse();
  });

  test("clearing drops every screen with the session that read them", () => {
    liveScene([{ paneId: "p1" }]);
    rememberPaneBuffer("p1", "screen", "h1");
    clearPaneBufferCache();
    openVisiting("p1");
    expect(restorePaneBuffer("p1")).toBeFalse();
  });
});
