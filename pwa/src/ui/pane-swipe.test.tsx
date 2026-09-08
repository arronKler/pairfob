import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { closeTestDialogs } from "../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { bumpViewIncarnation } from "../compose-drafts";
import { resetHerdAttention } from "../lib/herd-attention";
import { setLang } from "../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../lib/operations";
import { setRenderer } from "../paint";
import { app, clearNotice, state } from "../state";
import { goBackFromPane } from "./pane";
import { initSwipeBack } from "./pane-swipe";
import { renderApp } from "./react/app-screen";
import { leaveReactScreen, renderReactScreen } from "./react/root";

let dispose: (() => void) | undefined;
let backs = 0;
let now = 0;
let serial = -1;
const scheduled = new Map<number, { at: number; run: () => void }>();
let restoreTimers = () => {};
let restoreMedia = () => {};

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetHerdAttention();
  clearNotice();
  Object.assign(state, { phase: "live", screen: "pane", paneId: "p1", paneText: "ready", paneHash: "ready",
    boardReturn: false, fullTerminal: false, agentChat: false, paneRow: null, termSelect: false,
    paneFollow: true, paneUnread: false, composeDraft: "", composeIME: false, composeFocused: false,
    composeLive: false, keysExpanded: false, credential: null, computers: [], panePinned: {}, paneTouched: {},
    listGroup: "flat", listGroupCollapsed: {}, networkOnline: true, operationBusy: false,
    operationCapabilities: { ...NO_OPERATION_CAPABILITIES },
    agents: [{ paneId: "p1", paneLabel: "Owned conversation", agent: "codex", status: "idle", hasAgent: true,
      workspaceId: "w1", workspaceLabel: "Project", tabId: "t1", cwd: "/project" }] });
  state.live = { isConnected: () => true } as typeof state.live;
  setRenderer(renderApp);
  act(renderApp);
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
    leaveReactScreen();
    closeTestDialogs();
    await Promise.resolve();
  });
  restoreTimers();
  restoreMedia();
  restoreMedia = () => {};
  setRenderer(() => {});
  state.live = null;
  state.boardReturn = false;
  state.screen = "home";
  scheduled.clear();
});

function pane(): HTMLElement { return app.querySelector<HTMLElement>(".pane-root")!; }
function under(): HTMLElement | null { return app.querySelector(".pane-under"); }
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
  expect(app.firstChild).toBe(layer);
  expect(layer.nextSibling).toBe(root);
  expect(root.style.transform).toBe("translateX(102px)");
  const values = layer.style.transform.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  expect(values[0]).toBeCloseTo(-18 * (1 - 120 / 390), 10);
  expect(values[1]).toBeCloseTo(0.94 + 0.06 * (120 / 390), 10);
  act(renderApp);
  expect(pane()).toBe(root);
  expect(under()).toBe(layer);
  touch("touchend", 130, 20, root, 0);
  await tick(319);
  expect(backs).toBe(0);
  expect(layer.isConnected).toBe(true);
  await tick(1);
  expect(backs).toBe(1);
  expect(state.screen).toBe("home");
  expect(under()).toBeNull();
  expect(app.querySelectorAll(".page")).toHaveLength(1);
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
  state.screen = "home";
  act(renderApp);
  await settle();
  expect(under()).toBeNull();
  expect(scheduled.size).toBe(0);
  await tick(400);
  expect(backs).toBe(0);
  expect(app.querySelectorAll(".page")).toHaveLength(1);
});

test.each(["session", "pane", "incarnation"] as const)("late navigation cannot act on a changed %s even before a repaint", async change => {
  const root = drag();
  touch("touchend", 130, 20, root, 0);
  if (change === "session") state.live = { isConnected: () => true } as typeof state.live;
  else if (change === "pane") state.paneId = "p2";
  else bumpViewIncarnation();
  await tick(320);
  expect(backs).toBe(0);
  expect(under()).toBeNull();
  expect(state.screen).toBe("pane");
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
  expect(app.querySelectorAll(".pane-under")).toHaveLength(1);
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
  state.boardReturn = true;
  const root = drag();
  expect(under()).toBeNull();
  touch("touchcancel", 130, 20, root, 0);
  await tick(400);
  state.boardReturn = false;
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
  expect(state.screen).toBe("home");
  expect(scheduled.size).toBe(0);
});

test("terminal side-pan, desktop, and a second finger cannot initiate or retain a swipe", () => {
  act(() => renderReactScreen(<div className="pane-root"><div className="full-terminal-pan" /></div>));
  touch("touchstart", 10, 20, app.querySelector<HTMLElement>(".full-terminal-pan")!);
  expect(pane().classList.contains("edge-armed")).toBe(false);
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  touch("touchstart");
  expect(pane().classList.contains("edge-armed")).toBe(false);
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  drag();
  touch("touchstart", 10, 20, pane(), 2);
  expect(under()).toBeNull();
  expect(pane().style.transform).toBe("");
});

test("pagehide and app root unmount release active underlay roots without navigating", async () => {
  drag();
  act(() => window.dispatchEvent(new happy.Event("pagehide") as unknown as Event));
  expect(under()).toBeNull();
  drag();
  act(leaveReactScreen);
  await settle();
  expect(under()).toBeNull();
  expect(scheduled.size).toBe(0);
  expect(backs).toBe(0);
});
