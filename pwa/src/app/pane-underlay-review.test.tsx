import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../test-support/workspace-snapshot-restore";
import { appRoot } from "./dom-root";
import { unmountApp } from "./mount";
import { clearNotice } from "./notices-store";
import { setLang } from "../lib/i18n";
import type { LiveSession } from "../lib/protocol/client";
import { NO_OPERATION_CAPABILITIES } from "../lib/operations";
import { resetHerdAttention } from "../lib/herd-attention";
import { setPhase, setNetworkOnline } from "../features/connection/connection-store";
import { setScreen } from "./navigation-store";
import { applyCapabilities, setOperationBusy } from "../features/operations/capabilities-store";
import { attachLiveSession, credential, lastUsedDaemon, setCredential, setLastUsedDaemon } from "../features/computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../features/dashboard/catalog-store";
import {
  applyPaneRead,
  resetPaneView,
  selectPane,
  setAgentChat,
  setFullTerminal,
  setTermSelect,
} from "../features/session/session-store";
import { setComposeLive } from "../features/session/compose-store";
import { setBoardReturn } from "../features/board/layout-store";
import { setListGroup, listGroup, LIST_GROUP_KEY } from "../features/settings/preferences-store";
import { applyRuntimeIdentity, runtimeStore } from "../features/connection/runtime-store";
import { type ListGroup } from "../lib/ranking";
import { mountPaneUnderlay, type PaneUnderlay } from "../features/session/guided/pane-underlay";
import { initSwipeBack } from "../features/session/guided/pane-swipe";

let stop: (() => void) | undefined;
let standalone: PaneUnderlay | undefined;

const app = (): HTMLElement => appRoot();

// The pane seed (replaceAgentsFromSnapshot -> pruners) and this fixture's own
// boot write into TWO daemon scopes: the pre-test (foreign) credential scope and
// the fixture's own anonymous input (it sets credential null). Capture each scope
// with its own WorkspaceSnapshotRestorer before any seed, and restore with the
// correct credential order (anon first while still null, then re-apply the
// captured pre-test credential before the foreign restorer restores), so both
// scopes' exact raw preimages AND their respective canonical maps come back.
const foreignRestorer = new WorkspaceSnapshotRestorer();
const anonRestorer = new WorkspaceSnapshotRestorer();

// listGroup + runtime identity are also overwritten by this fixture's boot, and
// the pre-test credential/lastUsed ownership must be restored before the foreign
// snapshot restore. Captured once per case entry before ALL seed/boot; restored
// after own teardown; never re-captured inside a boot.
let foreignGroup: ListGroup = "flat";
let foreignGroupRaw: string | null = null;
let foreignHost = "";
let foreignKind = "";
let foreignCredential: ReturnType<typeof credential> = null;
let foreignLastUsed: string | null = null;
let foreignCaptured = false;
function captureForeignExtras(): void {
  if (foreignCaptured) return;
  foreignCaptured = true;
  foreignGroup = listGroup();
  foreignGroupRaw = localStorage.getItem(LIST_GROUP_KEY);
  foreignHost = runtimeStore.get().herdHost;
  foreignKind = runtimeStore.get().runtimeKind;
  foreignCredential = credential();
  foreignLastUsed = lastUsedDaemon();
}
function restoreForeignExtras(): void {
  if (!foreignCaptured) return;
  applyRuntimeIdentity({ herdHost: foreignHost, runtimeKind: foreignKind });
  setListGroup(foreignGroup);
  if (foreignGroupRaw === null) localStorage.removeItem(LIST_GROUP_KEY);
  else localStorage.setItem(LIST_GROUP_KEY, foreignGroupRaw);
  foreignCaptured = false;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetHerdAttention();
  clearNotice();
  // Foreign (pre-test credential) scope first, then this fixture's anonymous
  // input scope, both before any seed or prune.
  captureForeignExtras();
  foreignRestorer.capture();
  setCredential(null);
  anonRestorer.capture();
  // Pane screen through the named owners, then mount the actual App and commit.
  setPhase("live");
  setScreen("pane");
  resetPaneView();
  selectPane("p1");
  setFullTerminal(false);
  setAgentChat(false);
  setComposeLive(false);
  setTermSelect(false);
  setNetworkOnline(true);
  setOperationBusy(false);
  setBoardReturn(false);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  setListGroup("flat");
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "Project", cwd: "/project" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/project", agent: "codex", agent_status: "idle", label: "Review pane" }],
  });
  applyPaneRead("ready", "ready");
  attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
  mountTestApp();
  commitTest();
});

afterEach(async () => {
  await act(async () => {
    stop?.(); stop = undefined;
    standalone?.dispose(); standalone = undefined;
    unmountTestApp();
    // The retiring terminal schedules a scroll restore on the next frame and the
    // jump chip retires on a timer; drain both so neither lands outside an act
    // scope in a later suite.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
  attachLiveSession(null);
  resetHerdAttention();
  clearNotice();
  // Restore the anon scope first (credential is still this fixture's null
  // input), then re-apply the captured pre-test credential + lastUsed ownership
  // so the foreign restore replays under the SAME captured daemon/device scope.
  anonRestorer.restore();
  setCredential(foreignCredential);
  setLastUsedDaemon(foreignLastUsed);
  foreignRestorer.restore();
  restoreForeignExtras();
});

function touch(type: string, x: number, target: HTMLElement): void {
  const event = new happy.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchmove" || type === "touchstart" ? [{ identifier: 7, clientX: x, clientY: 20 }] : [],
  });
  target.dispatchEvent(event as unknown as Event);
}
function drag(): HTMLElement {
  const root = app().querySelector<HTMLElement>(".pane-root")!;
  touch("touchstart", 10, root);
  touch("touchmove", 150, root);
  return root;
}
async function mutations(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

test("portal disposal remains safe after the app React root is released and recreated immediately", () => {
  act(() => { standalone = mountPaneUnderlay(app(), "translateX(-18%) scale(0.94)"); });
  const layer = standalone!.element;
  expect(layer.isConnected).toBeTrue();
  act(() => { unmountApp(); mountTestApp(); commitTest(); });
  expect(app().querySelectorAll(".pane-root")).toHaveLength(1);
  expect(() => act(() => standalone!.dispose())).not.toThrow();
  expect(layer.isConnected).toBeFalse();
  expect(app().querySelectorAll(".pane-root")).toHaveLength(1);
});

test("gesture retirement preserves an external replacement transform and removes only its owned layer", async () => {
  let backs = 0;
  act(() => { stop = initSwipeBack(() => { backs++; }); });
  const root = app().querySelector<HTMLElement>(".pane-root")!;
  root.style.transform = "translateX(3px)";
  act(drag);
  const oldLayer = app().querySelector(".pane-under")!;
  root.style.transform = "translateX(8px)";
  act(() => stop?.());
  expect(root.style.transform).toBe("translateX(8px)");
  expect(oldLayer.isConnected).toBeFalse();
  expect(root.classList.contains("dragging")).toBeFalse();
  await mutations();
  expect(backs).toBe(0);
});

test("same-pane new-session reconciliation retires an active gesture before any touchend", async () => {
  let backs = 0;
  act(() => { stop = initSwipeBack(() => { backs++; }); });
  let oldRoot!: HTMLElement;
  act(() => { oldRoot = drag(); });
  const layer = app().querySelector(".pane-under")!;
  act(() => {
    attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
    commitTest();
  });
  await mutations();
  expect(app().querySelector(".pane-root") === oldRoot).toBeFalse();
  expect(layer.isConnected).toBeFalse();
  expect(oldRoot.classList.contains("dragging")).toBeFalse();
  act(() => touch("touchend", 150, oldRoot));
  expect(backs).toBe(0);
});