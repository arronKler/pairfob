import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { renderReact, unmountReact, mountTestApp, commitTest, unmountTestApp } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { bumpViewIncarnation } from "../drafts/compose-drafts";
import { resetHerdAttention } from "../../../lib/herd-attention";
import { setLang } from "../../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { DaemonPreferenceState } from "../../../../test-support/preferences-daemon-restore";
import { ScalarPreferenceState } from "../../../../test-support/preferences-scalar-restore";
import { clearNotice } from "../../../app/notices-store";
import { appRoot } from "../../../app/dom-root";
import { setScreen, currentScreen } from "../../../app/navigation-store";
import { setPhase, setNetworkOnline } from "../../connection/connection-store";
import { applyPaneRead, selectPane, setAgentChat, setFullTerminal, setPaneFollow, setPaneRow, setPaneUnread, setTermSelect } from "../session-store";
import { setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from "../compose-store";
import { setKeysExpanded, setListGroup, setListGroupCollapsed, listGroup, LIST_GROUP_KEY, resetHerdPresentationChoices, type ListGroup } from "../../settings/preferences-store";
import { setOperationBusy, applyCapabilities } from "../../operations/capabilities-store";
import { attachLiveSession, setCredential, setComputers } from "../../computers/catalog-store";
import { applySnapshot } from "../../dashboard/catalog-store";
import { setBoardReturn } from "../../board/layout-store";
import { goBackFromPane } from "../pane-actions";
import { initSwipeBack } from "./pane-swipe";
import type { LiveSession } from "../../../lib/protocol/client";

let dispose: (() => void) | undefined;
let backs = 0;
let now = 0;
let serial = -1;
const scheduled = new Map<number, { at: number; run: () => void }>();
let restoreTimers = () => {};
let restoreMedia = () => {};

// seedHerdSnapshot populates the HomeScreen agent card via a real snapshot, so
// capture the pre-seed dashboard/board projection + daemon maps + raw preimages
// before seeding and restore after teardown. Scalar/daemon preference resets
// (keysExpanded, paneComposeLive via setRandom etc.) persist; guard them too.
const snapshotRestorer = new WorkspaceSnapshotRestorer();
// applySnapshot runs under the anon credential scope (setCredential(null)) and
// prunes anon-scoped paneTermModes/paneComposeLive; capture that target scope
// after switching to anon but before seeding so the pruned anon raw keys are
// restored too, alongside the daemonA source scope (R2).
const anonSnapshotRestorer = new WorkspaceSnapshotRestorer();
const daemonPrefState = new DaemonPreferenceState();
const scalarPrefState = new ScalarPreferenceState();

// setListGroup persists LIST_GROUP_KEY (not covered by ScalarPreferenceState);
// capture raw + canonical and restore both after own teardown, narrowly.
let listGroupRaw: string | null = null;
let listGroupCanonical: ListGroup = "flat";

const AGENT_WIRE = {
  workspaces: [{ workspace_id: "w1", label: "Project", cwd: "/project" }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
  panes: [{
    pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/project",
    agent: "codex", agent_status: "idle", label: "Owned conversation",
  }],
};

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetHerdAttention();
  clearNotice();
  scalarPrefState.capture();
  daemonPrefState.capture();
  snapshotRestorer.capture();
  listGroupRaw = localStorage.getItem(LIST_GROUP_KEY);
  listGroupCanonical = listGroup();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  applyPaneRead("ready", "ready");
  setBoardReturn(false);
  setFullTerminal(false);
  setAgentChat(false);
  setPaneRow(null);
  setTermSelect(false);
  setPaneFollow(true);
  setPaneUnread(false);
  setComposeDraft("");
  setComposeIME(false);
  setComposeFocused(false);
  setComposeLive(false);
  setKeysExpanded(false);
  setComputers([]);
  setCredential(null);
  anonSnapshotRestorer.capture(); // anon-scope raws + INTACT canonical, before resetHerd
  resetHerdPresentationChoices(); // panePinned {} paneTouched {} listGroupCollapsed {}
  setListGroup("flat");
  setListGroupCollapsed({});
  setNetworkOnline(true);
  setOperationBusy(false);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  applySnapshot(AGENT_WIRE);
  attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
  mountTestApp();
  act(commitTest);
  backs = 0;
  now = 0;
  scheduled.clear();
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  const setSpy = spyOn(window, "setTimeout").mockImplementation(((run: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => {
    if ((ms === 320 || ms === 400) && typeof run === "function") {
      const id = serial--;
      scheduled.set(id, { at: now + ms, run: () => run(...args) });
      return id;
    }
    return set(run, ms, ...args);
  }) as typeof window.setTimeout);
  const clearSpy = spyOn(window, "clearTimeout").mockImplementation((id: number | undefined) => {
    if (id !== undefined && scheduled.delete(id)) return;
    clear(id);
  });
  restoreTimers = () => { setSpy.mockRestore(); clearSpy.mockRestore(); };
  act(() => { dispose = initSwipeBack(() => { backs++; goBackFromPane(); }); });
});

afterEach(async () => {
  await act(async () => {
    dispose?.();
    dispose = undefined;
    unmountTestApp();
    closeTestDialogs();
    await Promise.resolve();
  });
  restoreTimers();
  restoreMedia();
  restoreMedia = () => {};
  act(() => {
    attachLiveSession(null);
    setBoardReturn(false);
    setScreen("home");
  });
  scalarPrefState.restore();
  daemonPrefState.restore();
  snapshotRestorer.restore();
  anonSnapshotRestorer.restore();
  // Restore setListGroup's persisted LIST_GROUP_KEY exactly (raw then canonical).
  setListGroup(listGroupCanonical);
  if (listGroupRaw === null) localStorage.removeItem(LIST_GROUP_KEY);
  else localStorage.setItem(LIST_GROUP_KEY, listGroupRaw);
  scheduled.clear();
});

function pane(): HTMLElement { return appRoot().querySelector<HTMLElement>(".pane-root")!; }
function under(): HTMLElement | null { return appRoot().querySelector(".pane-under"); }
function touch(type: string, x = 10, y = 20, target: HTMLElement = pane(), count = 1): Event {
  const event = new happy.Event(type, { bubbles: true, cancelable: true });
  const touches = Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y }));
  Object.defineProperty(event, "touches", { value: touches });
  act(() => target.dispatchEvent(event as unknown as Event));
  return event as unknown as Event;
}
function drag(dx = 120): HTMLElement {
  const root = pane();
  touch("touchstart", 10, 20, root);
  touch("touchmove", 10 + dx, 20, root);
  return root;
}
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function tick(ms: number): Promise<void> {
  const until = now + ms;
  await act(async () => {
    for (;;) {
      const next = [...scheduled.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      scheduled.delete(next[0]);
      now = next[1].at;
      next[1].run();
      await Promise.resolve();
    }
    now = until;
  });
}

test("the real React HomeScreen underlay keeps sibling order and leaves no node after actual route reconciliation", async () => {
  const root = drag();
  const layer = under()!;
  expect(layer.getAttribute("aria-hidden")).toBe("true");
  expect(layer.querySelector(".page .card-name")?.textContent).toBe("Owned conversation");
  expect(Object.keys(layer.querySelector(".page")!).some(key => key.startsWith("__reactFiber$"))).toBe(true);
  expect(appRoot().firstChild).toBe(layer);
  expect(layer.nextSibling).toBe(root);
  expect(root.style.transform).toBe("translateX(102px)");
  const values = layer.style.transform.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(values[0]).toBeCloseTo(-18 * (1 - 120 / 390), 10);
  expect(values[1]).toBeCloseTo(0.94 + 0.06 * (120 / 390), 10);
  act(commitTest);
  expect(pane()).toBe(root);
  expect(under()).toBe(layer);
  touch("touchend", 130, 20, root, 0);
  await tick(319);
  expect(backs).toBe(0);
  expect(layer.isConnected).toBe(true);
  await tick(1);
  expect(backs).toBe(1);
  expect(currentScreen()).toBe("home");
  expect(under()).toBeNull();
  expect(appRoot().querySelectorAll(".page")).toHaveLength(1);
  expect(scheduled.size).toBe(0);
});

test("edge and horizontal engagement thresholds keep vertical scrolling native", () => {
  touch("touchstart", 29);
  expect(pane().classList.contains("edge-armed")).toBe(false);
  touch("touchstart", 28);
  expect(touch("touchmove", 41).defaultPrevented).toBe(false);
  expect(under()).toBeNull();
  expect(touch("touchmove", 42, 40).defaultPrevented).toBe(false);
  expect(under()).toBeNull();
  expect(touch("touchmove", 42, 20).defaultPrevented).toBe(true);
  expect(under()).not.toBeNull();
});

test.each([90, 91])("back requires strictly more than 90 px, travel=%i", async dx => {
  const root = drag(dx);
  touch("touchend", 10 + dx, 20, root, 0);
  await tick(400);
  expect(backs).toBe(dx > 90 ? 1 : 0);
  expect(under()).toBeNull();
  expect(root.classList.contains("settling")).toBe(false);
  expect(scheduled.size).toBe(0);
});

test("native touch cancellation above the threshold never navigates and releases the transition listener", async () => {
  const root = drag(150);
  const layer = under()!;
  touch("touchcancel", 160, 20, root, 0);
  expect(layer.style.transform).toBe("translateX(-18%) scale(0.94)");
  act(() => layer.dispatchEvent(new happy.Event("transitionend") as unknown as Event));
  expect(under()).toBeNull();
  await tick(400);
  expect(backs).toBe(0);
  expect(root.style.transform).toBe("");
  expect(scheduled.size).toBe(0);
});

test("a route repaint retires an in-flight underlay and its delayed navigation", async () => {
  const root = drag();
  touch("touchend", 130, 20, root, 0);
  act(() => { setScreen("home"); commitTest(); });
  await settle();
  expect(under()).toBeNull();
  expect(scheduled.size).toBe(0);
  await tick(400);
  expect(backs).toBe(0);
  expect(appRoot().querySelectorAll(".page")).toHaveLength(1);
});

test.each(["session", "pane", "incarnation"] as const)("late navigation cannot act on a changed %s even before a repaint", async change => {
  const root = drag();
  touch("touchend", 130, 20, root, 0);
  act(() => {
    if (change === "session") attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
    else if (change === "pane") selectPane("p2");
    else bumpViewIncarnation();
  });
  await tick(320);
  expect(backs).toBe(0);
  expect(under()).toBeNull();
  expect(currentScreen()).toBe("pane");
  expect(root.style.transform).toBe("");
});

test("a repeated gesture cancels the old navigation and retires only its own underlay root", async () => {
  const root = drag();
  const old = under()!;
  touch("touchend", 130, 20, root, 0);
  drag(40);
  const next = under()!;
  expect(old.isConnected).toBe(false);
  expect(next).not.toBe(old);
  expect(appRoot().querySelectorAll(".pane-under")).toHaveLength(1);
  touch("touchend", 50, 20, root, 0);
  await tick(400);
  expect(backs).toBe(0);
  expect(under()).toBeNull();
});

test("reinitialization and stale disposers cannot double-register or remove the new binding", async () => {
  const root = drag();
  const old = dispose!;
  let nextBacks = 0;
  act(() => { dispose = initSwipeBack(() => { nextBacks++; }); old(); });
  expect(under()).toBeNull();
  expect(root.style.transform).toBe("");
  drag();
  touch("touchend", 130, 20, root, 0);
  await tick(320);
  expect(backs).toBe(0);
  expect(nextBacks).toBe(1);
  expect(under()).toBeNull();
});

test("disposing an active gesture unmounts HomeScreen bindings and removes app touch listeners", async () => {
  const root = drag();
  const card = under()!.querySelector<HTMLButtonElement>(".card-main")!;
  act(() => dispose?.());
  expect(under()).toBeNull();
  expect(root.style.transform).toBe("");
  expect(root.classList.contains("edge-armed")).toBe(false);
  document.body.append(card);
  try {
    act(() => card.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(document.querySelector("dialog")).toBeNull();
  } finally { card.remove(); }
  drag();
  expect(under()).toBeNull();
  expect(root.classList.contains("edge-armed")).toBe(false);
  await tick(400);
  expect(backs).toBe(0);
});

test("board return keeps its camera and reduced motion skips the borrowed list and delay", async () => {
  setBoardReturn(true);
  const root = drag();
  expect(under()).toBeNull();
  touch("touchcancel", 130, 20, root, 0);
  await tick(400);
  setBoardReturn(false);
  const original = globalThis.matchMedia;
  globalThis.matchMedia = query => {
    const media = original(query);
    if (query === "(prefers-reduced-motion: reduce)") Object.defineProperty(media, "matches", { value: true });
    return media;
  };
  restoreMedia = () => { globalThis.matchMedia = original; };
  drag();
  expect(under()).toBeNull();
  touch("touchend", 130, 20, root, 0);
  expect(backs).toBe(1);
  expect(currentScreen()).toBe("home");
  expect(scheduled.size).toBe(0);
});

test("terminal side-pan, desktop, and a second finger cannot initiate or retain a swipe", () => {
  // The real App host no longer adopts an injected screen after mount; use a
  // legitimate separate component boundary: tear down the App, then render the
  // synthetic pane-root through the leaf harness root. initSwipeBack still
  // listens on the app root and lazily finds this .pane-root.
  act(() => { unmountTestApp(); });
  renderReact(<div className="pane-root"><div className="full-terminal-pan" /></div>);
  touch("touchstart", 10, 20, appRoot().querySelector<HTMLElement>(".full-terminal-pan")!);
  expect(pane().classList.contains("edge-armed")).toBe(false);
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  touch("touchstart");
  expect(pane().classList.contains("edge-armed")).toBe(false);
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  drag();
  touch("touchstart", 10, 20, pane(), 2);
  expect(under()).toBeNull();
  expect(pane().style.transform).toBe("");
  unmountReact();
});

test("pagehide and app root unmount release active underlay roots without navigating", async () => {
  drag();
  act(() => window.dispatchEvent(new happy.Event("pagehide") as unknown as Event));
  expect(under()).toBeNull();
  drag();
  act(unmountTestApp);
  await settle();
  expect(under()).toBeNull();
  expect(scheduled.size).toBe(0);
  expect(backs).toBe(0);
});