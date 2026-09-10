import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { currentScreen, goToScreen, setScreen } from "../../app/navigation-store";
import { boardStore, resetBoardCatalog, setBoardCamera, setBoardReturn } from "../../features/board/layout-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { resetPaneView, selectPane } from "../../features/session/session-store";
import { clearNotice } from "../../app/notices-store";
import { runtimeStore } from "../../features/connection/runtime-store";
import type { SnapshotWire } from "../../lib/dashboard";
import type { OperationCapabilities } from "../../lib/operations";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/session-types";
import { setLang, t } from "../../lib/i18n";
import { boardPreviewText, clearBoardPreviews } from "../../features/board/preview/store";
import { releaseBoardScroll } from "./pane-scroll";
import { refreshBoardPreviews } from "../../features/board/preview/refresh";

function snapshot(withPane: boolean): SnapshotWire {
  return {
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: withPane ? "w1:p1" : "" },
    workspaces: [{ workspace_id: "w1", label: "Workspace" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "Main" }],
    panes: withPane
      ? [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", agent: "codex", agent_status: "idle", label: "Pane" }]
      : [],
    layouts: [],
  };
}

function defaultLive(): LiveSession {
  return { isConnected: () => true, paneRead: async () => ({ text: "", hash: "" }) } as unknown as LiveSession;
}

const DEFAULT_CAPS: OperationCapabilities = { ...NO_OPERATION_CAPABILITIES, create_tab: true };
const NO_CAPS: OperationCapabilities = { ...NO_OPERATION_CAPABILITIES };

async function boot(
  forSnapshot: SnapshotWire = snapshot(true),
  live: LiveSession = defaultLive(),
  capabilities: OperationCapabilities = DEFAULT_CAPS,
): Promise<void> {
  setPhase("live");
  applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
  setNetworkOnline(true);
  // Explicit baseline: the legacy suite always started from a closed pane, an
  // unset return path and no in-flight operation — not from resetPaneView.
  selectPane("");
  setBoardReturn(false);
  setOperationBusy(false);
  resetPaneView();
  applyCapabilities(capabilities, []);
  attachLiveSession(live);
  replaceAgentsFromSnapshot(forSnapshot);
  // A fitted camera, so the canvas never refits behind the assertions below.
  setBoardCamera({ scale: 1, panX: 0, panY: 0 }, true);
  goToScreen("board");
  mountTestApp();
  commitTest();
}

/**
 * The empty board the last case starts from: no catalog, no focus, no herd
 * identity — exactly the original runtime-write fixture seed.
 */
async function bootEmpty(): Promise<void> {
  setPhase("live");
  applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
  setNetworkOnline(true);
  selectPane("");
  setBoardReturn(false);
  setOperationBusy(false);
  // The original runtime case also booted with fullTerminal=false and
  // agentChat=false; selectPane("") does not clear those pane modes.
  resetPaneView();
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  attachLiveSession(defaultLive());
  replaceAgentsFromSnapshot({ focused: { workspace_id: "", tab_id: "", pane_id: "" }, workspaces: [], tabs: [], panes: [], layouts: [] });
  goToScreen("board");
  mountTestApp();
  commitTest();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(async () => {
  releaseBoardScroll();
  closeTestDialogs();
  act(clearBoardPreviews);
  act(() => {
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    setOperationBusy(false);
    clearNotice();
    setScreen("home");
  });
  unmountTestApp();
  appRoot().replaceChildren();
});

test("clearing previews and changing session rejects the old in-flight read before publishing to React", async () => {
  let complete!: (value: { text: string; hash: string }) => void;
  let reads = 0;
  const deferred: LiveSession = {
    isConnected: () => true,
    paneRead: () => {
      reads += 1;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  } as unknown as LiveSession;
  await boot(snapshot(true), deferred);
  const tile = appRoot().querySelector(".board-pane")!;
  const pending = refreshBoardPreviews();
  await Promise.resolve();
  expect(reads).toBe(1);
  act(clearBoardPreviews);
  act(() => attachLiveSession({
    isConnected: () => true,
    paneRead: async () => ({ text: "new computer", hash: "new" }),
  } as unknown as LiveSession));
  await act(async () => {
    complete({ text: "old computer private output", hash: "old" });
    await pending;
  });
  expect(appRoot().querySelector(".board-pane") === tile).toBeTrue();
  expect(tile.querySelector(".board-pane-screen")!.textContent).not.toContain("old computer private output");
  expect(boardPreviewText("w1:p1")).toBe("");
});

test("an empty tab gaining fallback panes binds gestures despite the unchanged explicit-layout signature", async () => {
  await boot(snapshot(false));
  const signature = boardStore.get().lastLayoutSig;
  const viewport = appRoot().querySelector<HTMLElement>(".board-canvas")!;
  expect(appRoot().querySelector(".board-stage")).toBeNull();
  act(() => replaceAgentsFromSnapshot(snapshot(true)));
  expect(boardStore.get().lastLayoutSig).toBe(signature);
  expect(appRoot().querySelector(".board-canvas") === viewport).toBeTrue();
  expect(appRoot().querySelector(".board-stage") !== null).toBeTrue();
  const before = boardStore.get().boardScale;
  act(() => viewport.dispatchEvent(new happy.WheelEvent("wheel", {
    bubbles: true, cancelable: true, ctrlKey: true, deltaY: -1, clientX: 30, clientY: 40,
  }) as unknown as Event));
  expect(boardStore.get().boardScale).toBeGreaterThan(before);
});

test("removing a fallback stage retires the in-progress gesture on its retained viewport", async () => {
  await boot(snapshot(true));
  const viewport = appRoot().querySelector<HTMLElement>(".board-canvas")!;
  act(() => viewport.dispatchEvent(new happy.PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10,
  }) as unknown as Event));
  act(() => replaceAgentsFromSnapshot(snapshot(false)));
  expect(appRoot().querySelector(".board-canvas") === viewport).toBeTrue();
  expect(appRoot().querySelector(".board-stage")).toBeNull();
  const before = boardStore.get().boardPanX;
  act(() => viewport.dispatchEvent(new happy.PointerEvent("pointermove", {
    bubbles: true, cancelable: true, pointerId: 1, clientX: 60, clientY: 10,
  }) as unknown as Event));
  expect(boardStore.get().boardPanX).toBe(before);
});

test("the actual board route keeps capability and connection gates before opening a scoped tab form", async () => {
  let mutations = 0;
  let connected = true;
  await boot(snapshot(true), {
    isConnected: () => connected,
    createTab: async () => {
      mutations += 1;
    },
  } as unknown as LiveSession, NO_CAPS);
  expect(appRoot().classList.contains("board")).toBeTrue();
  expect(appRoot().querySelector(".board-tab-new")).toBeNull();
  act(() => applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []));
  act(() => setOperationBusy(true));
  const create = appRoot().querySelector<HTMLButtonElement>(".board-tab-new")!;
  expect(create.disabled).toBeTrue();
  act(() => create.click());
  expect(document.querySelector("dialog")).toBeNull();
  act(() => setOperationBusy(false));
  connected = false;
  commitTest();
  expect(appRoot().querySelector(".board-tab-new") === create).toBeTrue();
  expect(create.disabled).toBeTrue();
  connected = true;
  commitTest();
  expect(create.disabled).toBeFalse();
  act(() => create.click());
  const cwd = document.querySelector<HTMLInputElement>('dialog input[name="cwd"]');
  expect(cwd?.value).toBe("/repo");
  expect(currentScreen()).toBe("board");
  expect(mutations).toBe(0);
});

test("the mounted board receives runtime identity through its domain subscription", async () => {
  setLang("zh");
  await bootEmpty();
  expect(appRoot().querySelector(".banner-off")).toBeNull();
  // A named runtime write publishes immediately; the mounted App applies the
  // identity from its real domain subscription and renders the status. There is
  // no facade dirty-hold here: runtime has no staging API, and the generic
  // pending-composition barrier is covered by the subscriptions fixtures.
  act(() => applyRuntimeIdentity({ herdHost: "", runtimeKind: "offline" }));
  expect(runtimeStore.get().runtimeKind).toBe("offline");
  expect(appRoot().querySelector(".banner-off")?.textContent).toBe(t("chrome.herdrOffBanner"));
});