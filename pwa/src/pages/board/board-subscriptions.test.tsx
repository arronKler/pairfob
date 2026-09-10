import { resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { appHost, type AppHost } from "../../app/host";
import { boardStore, focusBoard, projectSnapshot, setBoardCamera } from "../../features/board/layout-store";
import { applyCapabilities } from "../../features/operations/capabilities-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { connectionStore, setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { dashboardStore, replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { goToScreen, setScreen } from "../../app/navigation-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { resetPaneView } from "../../features/session/session-store";
import { clearNotice } from "../../app/notices-store";
import { resetBoardCatalog } from "../../features/board/layout-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import { cameraTransform } from "../../features/board/model/camera";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { BoardPage } from "./index";
import { presentBoardView, readBoardCamera, selectTab, selectWorkspace } from "./board-bridge";

const AGENT_KINDS = [] as const;

function snapshot(tabId: string, workspaceId: string) {
  return {
    focused: { workspace_id: workspaceId, tab_id: tabId, pane_id: `${tabId}:p1` },
    workspaces: [
      { workspace_id: "w1", label: "alpha" },
      { workspace_id: "w2", label: "beta" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "logs" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "review" },
    ],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "claude", agent_status: "idle", label: "one" },
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", cwd: "/tmp/a", agent: "claude", agent_status: "working", label: "logs-pane" },
      { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", cwd: "/tmp/b", agent: "grok", agent_status: "blocked", label: "beta-one" },
    ],
  };
}

/** A selection starts a preview pass; let it land inside act so nothing leaks. */
async function select(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function selected(selector: string): string | null {
  return appRoot().querySelector(selector)?.textContent ?? null;
}

/**
 * Count App host commits/requests, not a synthetic renderer. Captured AFTER the
 * initial mount+commit, so the mounting navigation is never part of a fixture
 * assertion about "no extra commit". The wrapped methods forward to the exact
 * reference they replaced; the originals are restored at teardown.
 */
let committed = 0;
let requested = 0;
let hostRef: AppHost | null = null;
let realCommit: AppHost["commit"] | null = null;
let realRequestCommit: AppHost["requestCommit"] | null = null;

function watchHostCommits(): void {
  hostRef = appHost();
  expect(hostRef).not.toBeNull();
  committed = 0;
  requested = 0;
  realCommit = hostRef!.commit;
  realRequestCommit = hostRef!.requestCommit;
  hostRef!.commit = (options) => {
    committed += 1;
    realCommit!(options);
  };
  hostRef!.requestCommit = () => {
    requested += 1;
    realRequestCommit!();
  };
}

function restoreHostCommits(): void {
  if (!hostRef) return;
  if (realCommit) hostRef.commit = realCommit;
  if (realRequestCommit) hostRef.requestCommit = realRequestCommit;
  hostRef = null;
  realCommit = null;
  realRequestCommit = null;
}

/** Seed the board domains and stage the board screen before the App mounts. */
function seedBoard(): void {
  setPhase("live");
  applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
  setNetworkOnline(true);
  resetPaneView();
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, [...AGENT_KINDS]);
  attachLiveSession({
    isConnected: () => true,
    paneRead: async () => ({ text: "", hash: "" }),
  } as unknown as LiveSession);
  replaceAgentsFromSnapshot(snapshot("w1:t1", "w1"));
  // A fold keeps a still-valid focus, so each test starts from the same board.
  focusBoard("w1", "w1:t1");
  // A fitted camera, so the canvas never refits behind the assertions below.
  setBoardCamera({ scale: 1, panX: 0, panY: 0 }, true);
  goToScreen("board");
}

/**
 * Mount the stable App on the board and start counting host commits. The
 * original `select(action)` timing is preserved exactly: in-screen writes
 * publish and the page re-renders from its own domain subscriptions, with no
 * extra drain. Counters install AFTER the mounting commit, so the mounting
 * navigation is never part of a fixture check.
 */
function mountBoard(): void {
  mountTestApp();
  commitTest();
  watchHostCommits();
}

/** Seed then mount: the common path for the subscription cases. */
function boot(): void {
  seedBoard();
  mountBoard();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(() => {
  restoreHostCommits();
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    clearNotice();
    setScreen("home");
  });
  unmountTestApp();
  appRoot().replaceChildren();
});

describe("mounted board updates from typed domain actions", () => {
  test("selecting a tab and a workspace repaints nothing and updates everything", async () => {
    boot();
    expect(selected(".board-tab.on")).toBe(t("board.tabIndex", { n: 1 }));
    expect(selected(".board-chip.on")).toBe("alpha");
    expect(appRoot().querySelectorAll(".board-pane")).toHaveLength(1);

    await select(() => selectTab("w1:t2"));
    expect(selected(".board-tab.on")).toBe("logs");
    expect(selected(".board-pane-name")).toBe("logs-pane");
    expect(committed).toBe(0);
    expect(requested).toBe(0);

    await select(() => selectWorkspace("w2"));
    expect(selected(".board-chip.on")).toBe("beta");
    expect(selected(".board-tab.on")).toBe("review");
    expect(selected(".board-pane-name")).toBe("beta-one");
    expect(committed).toBe(0);
    expect(requested).toBe(0);

    // Selecting what is already selected publishes nothing at all.
    const camera = readBoardCamera();
    await select(() => selectWorkspace("w2"));
    expect(readBoardCamera()).toEqual(camera);
    expect(committed).toBe(0);
    expect(requested).toBe(0);
  });

  test("a camera write is scoped out of the page: no commit, no re-render", async () => {
    boot();
    const stage = appRoot().querySelector<HTMLElement>(".board-stage")!;
    const tiles = [...appRoot().querySelectorAll(".board-pane")];
    expect(stage.style.transform).toBe("translate(0px, 0px) scale(1)");

    // A pan or pinch writes the camera many times a second.
    act(() => {
      setBoardCamera({ scale: 2, panX: 40, panY: -20 }, true);
      setBoardCamera({ scale: 2, panX: 55, panY: -20 }, true);
      setBoardCamera({ scale: 2.4, panX: 55, panY: -35 }, true);
    });
    expect(readBoardCamera()).toEqual({ scale: 2.4, panX: 55, panY: -35, fitted: true });
    // No commit happened: the stage still carries the transform of the last render,
    // and the gesture adapter is the only thing that paints a camera mid-gesture.
    expect(stage.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(appRoot().querySelector(".board-pane")).toBe(tiles[0]);
    expect(committed).toBe(0);
    expect(requested).toBe(0);

    // A catalog change does re-render, and the stage carries whatever camera the
    // commit settled on — the written one, or the refit a new tab earns.
    await select(() => selectTab("w1:t2"));
    expect(selected(".board-tab.on")).toBe("logs");
    const settled = readBoardCamera();
    expect(appRoot().querySelector<HTMLElement>(".board-stage")!.style.transform).toBe(cameraTransform(settled));
    expect(committed).toBe(0);
    expect(requested).toBe(0);
  });

  test("the projection and the mounted screen agree, and presenting mutates nothing", async () => {
    seedBoard();
    // Present from the very seed that mounts: no second seed after the
    // projection, so the model/DOM comparison uses one identical world.
    const before = JSON.stringify(boardStore.get());
    const view = presentBoardView();
    expect(JSON.stringify(boardStore.get())).toBe(before);
    mountBoard();
    expect(view.tabs.map((tab) => tab.label)).toEqual([t("board.tabIndex", { n: 1 }), "logs"]);
    expect([...appRoot().querySelectorAll(".board-tab")].map((node) => node.textContent)).toEqual(view.tabs.map((tab) => tab.label));
    expect(appRoot().querySelector(".board-tab-new")).not.toBeNull();
    // The capability is withdrawn: the mounted board drops the control by itself.
    act(() => applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []));
    expect(appRoot().querySelector(".board-tab-new")).toBeNull();
    expect(committed).toBe(0);
    expect(requested).toBe(0);
  });

  test("a board-only catalog publication updates the rendered workspace label", async () => {
    boot();
    expect(selected(".board-chip.on")).toBe("alpha");
    const next = snapshot("w1:t1", "w1");
    next.workspaces[0].label = "Renamed workspace";
    act(() => projectSnapshot(next, [...dashboardStore.get().agents]));
    expect(selected(".board-chip.on")).toBe("Renamed workspace");
    expect(committed).toBe(0);
    expect(requested).toBe(0);
  });

  test("BoardPage render does not publish an unrelated dirty domain", async () => {
    boot();

    const events: Array<{ published: boolean; fromRender: boolean }> = [];
    const stop = connectionStore.subscribe(() => {
      events.push({
        published: connectionStore.get().networkOnline,
        fromRender: !!new Error().stack?.includes("presentBoardView"),
      });
    });

    // A staged phase action on the connection domain holds a following ordinary
    // network write until the host commit: this is a real publication barrier,
    // not an immediate publish. Producer timing is preserved — the write lands
    // before the render that must not flush it.
    setPhase("pick");
    setNetworkOnline(false);
    expect(connectionStore.get().networkOnline).toBe(true);
    expect(connectionStore.get().phase).toBe("live");

    // Render the page through its StrictMode presentation boundary (as the
    // legacy case did). The page's render is a pure projection: it publishes
    // nothing and never flushes the unrelated pending connection write.
    const hostEl = document.createElement("div");
    document.body.append(hostEl);
    const strictRoot = createRoot(hostEl);
    act(() => strictRoot.render(createElement(StrictMode, null, createElement(BoardPage))));
    expect(events.filter((event) => event.fromRender)).toEqual([]);
    expect(connectionStore.get().networkOnline).toBe(true);
    act(() => strictRoot.unmount());
    hostEl.remove();

    // Only the explicit host commit is the release point for the held write.
    commitTest();
    expect(connectionStore.get().networkOnline).toBe(false);
    expect(events.filter((event) => event.fromRender)).toEqual([]);

    stop();
  });
});