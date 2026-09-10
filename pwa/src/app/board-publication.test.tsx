import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../test-support/react-harness";
import { appRoot } from "./dom-root";
import { batch } from "../shared/model/domain-store";
import { boardStore, liveBoardCatalog, resetBoardCatalog, setBoardReturn, stageBoardReturnCleared } from "../features/board/layout-store";
import { publishAllDomains } from "./domain-publication";
import { runtimeStore } from "../features/connection/runtime-store";
import { setLang, t } from "../lib/i18n";
import { setPhase, setNetworkOnline } from "../features/connection/connection-store";
import { setScreen } from "./navigation-store";
import { attachLiveSession } from "../features/computers/catalog-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../features/dashboard/catalog-store";
import { resetBoardCatalog } from "../features/board/layout-store";
import { resetPaneView, setAgentChat, setFullTerminal } from "../features/session/session-store";
import { applyRuntimeIdentity } from "../features/connection/runtime-store";
import type { LiveSession } from "../lib/protocol/client";

/**
 * Stable App publication seam for board/runtime domains.
 *
 * A plain typed write publishes to subscribers immediately and the next frame
 * applies it; a second commit with no new writes re-publishes nothing. Staged
 * COMPOSITION writes (a staged board return plus a catalog snapshot written
 * while the composition holds) stay invisible to subscribers and the board
 * store until the App commit flushes dirty domains — never published by a React
 * render alone. This exercises the real typed staging actions and commit
 * boundary, not the removed facade dirty-deferral.
 */

function live(): LiveSession {
  return { isConnected: () => true } as LiveSession;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  batch(() => {
    setPhase("live");
    setScreen("board");
    resetPaneView();
    setAgentChat(false);
    setFullTerminal(false);
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    attachLiveSession(live());
    resetDashboard();
    resetBoardCatalog();
  });
  publishAllDomains();
  mountTestApp();
  commitTest();
});

afterEach(() => {
  unmountTestApp();
});

describe("stable App board seam", () => {
  test("a typed runtime write publishes at once and the banner flushes on the next act", async () => {
    expect(appRoot().querySelector(".banner-off")).toBeNull();
    expect(runtimeStore.get().runtimeKind).toBe("herdr");

    // Named domain actions publish to subscribers immediately (there is no
    // legacy dirty-until-paint deferral); React applies it inside act.
    await act(async () => { applyRuntimeIdentity({ herdHost: "", runtimeKind: "offline" }); });
    expect(runtimeStore.get().runtimeKind).toBe("offline");
    expect(appRoot().querySelector(".banner-off")?.textContent).toBe(t("chrome.herdrOffBanner"));
  });

  test("a typed board catalog write publishes at once and the chip renders on flush", async () => {
    expect(boardStore.get().workspaceList).toEqual([]);

    await act(async () => {
      replaceAgentsFromSnapshot({ workspaces: [{ workspace_id: "w1", label: "Renamed", cwd: "/r" }] });
    });
    expect(boardStore.get().workspaceList.map((space) => space.label)).toEqual(["Renamed"]);
    expect(appRoot().querySelector(".board-chip")?.textContent).toBe("Renamed");
  });

  test("a second commit without new writes does not re-publish board or runtime stores", async () => {
    let runtimeNotices = 0;
    let boardNotices = 0;
    const releaseRuntime = runtimeStore.subscribe(() => { runtimeNotices += 1; });
    const releaseBoard = boardStore.subscribe(() => { boardNotices += 1; });
    const baselineRuntime = runtimeNotices;
    const baselineBoard = boardNotices;

    commitTest();

    expect(runtimeNotices).toBe(baselineRuntime);
    expect(boardNotices).toBe(baselineBoard);
    releaseRuntime();
    releaseBoard();
  });

  test("a staged board return and held catalog publish only when the actual App commits", async () => {
    // Typed composition staging: board return is staged (cleared) and a catalog
    // snapshot is written while a composition holds, so the live board camera sees
    // the new catalog but the board store stays empty and subscribers get nothing
    // until the App commit flushes it. No facade markDirty — the typed staged
    // action (stageBoardReturnCleared) and the composition commit are the barrier.
    act(() => { setBoardReturn(true); });
    let notices = 0;
    const release = boardStore.subscribe(() => { notices += 1; });
    try {
      await act(async () => {
        stageBoardReturnCleared();
        replaceAgentsFromSnapshot({ workspaces: [{ workspace_id: "w1", label: "Held New", cwd: "/r" }] });
        // Live camera projection reads the staged catalog; the store is still empty.
        expect(liveBoardCatalog().workspaceList.map((space) => space.label)).toEqual(["Held New"]);
        expect(boardStore.get().workspaceList).toEqual([]);
        expect(notices).toBe(0);
        commitTest();
      });
      // The commit flushed the held catalog exactly once and rendered the chip.
      expect(boardStore.get().workspaceList.map((space) => space.label)).toEqual(["Held New"]);
      expect(appRoot().querySelector(".board-chip")?.textContent).toBe("Held New");
      expect(notices).toBe(1);
    } finally {
      release();
    }
  });
});
