import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { noteKeydown, resetInputMode } from "../../../app/input-mode";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { bindKeyboardZones } from "../../../lib/dom";
import { setLang, t } from "../../../lib/i18n";
import { noteSessionChosen } from "../../session/focus";
import type { HerdActions } from "../actions";
import { buildHerdViewModel, type HerdModelInput, type HerdViewModel } from "../model/herd-view";
import { HerdScreen } from "./herd-screen";

/**
 * The rail's list is one keyboard stop: Tab arrives on the open session and
 * leaves again, and the arrows walk headings, rows and what each has of its
 * own. The phone page keeps a stop for every control, as it always had.
 */
const app = appRoot;
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const realMatchMedia = window.matchMedia;

function pointer(fine: boolean): void {
  window.matchMedia = ((query: string) => query === FINE_POINTER
    ? { matches: fine, media: query, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia.call(window, query)) as typeof window.matchMedia;
}

function agent(id: string, workspace: string, status: DashboardAgentCard["status"] = "idle"): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status,
    workspaceId: workspace, workspaceLabel: workspace, workspaceCwd: `/work/${workspace}`,
    cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab`,
  };
}

const herd = [agent("a1", "alpha", "blocked"), agent("a2", "alpha", "done"), agent("b1", "beta"), agent("b2", "beta")];

function model(overrides: Partial<HerdModelInput> = {}): HerdViewModel {
  return buildHerdViewModel({
    agents: herd,
    listGroup: "space",
    paneTouched: {},
    paneActivated: {},
    panePinned: {},
    groupCollapsed: {},
    selectedPaneId: "",
    attention: { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] },
    liveness: "live",
    status: { tone: "live", text: "已连接" },
    reading: false,
    snapshotLoaded: true,
    recentDirs: [],
    connected: true,
    networkOnline: true,
    runtimeKind: "herdr",
    createConversation: true,
    operationBusy: false,
    morphingPaneId: null,
    host: { name: "studio", line: "已连接", tone: "live" },
    createTab: true,
    now: 10 * 60_000,
    ...overrides,
  });
}

let calls: string[] = [];
const actions = {
  openPaneFromCard: (paneId: string) => calls.push(`open:${paneId}`),
  openPaneMenu: (card: { paneId: string }) => calls.push(`menu:${card.paneId}`),
  openWorkspaceMenu: (card?: { paneId: string }) => calls.push(`workspaceMenu:${card?.paneId}`),
  toggleGroup: (groupId: string) => calls.push(`toggle:${groupId}`),
  createInWorkspace: () => calls.push("createIn"),
  revealAttention: (groupId: string, kind: string) => calls.push(`reveal:${groupId}:${kind}`),
  togglePin: (paneId: string) => calls.push(`pin:${paneId}`),
  markRead: (paneId: string) => calls.push(`read:${paneId}`),
  openHostMenu() {}, openGroupModeMenu() {}, openAttention() {}, openBoard() {}, openSettings() {}, openQuickCreate() {},
  createConversation() {}, openCreate() {},
} as unknown as HerdActions;

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/** The list settles after the change that asked for it: one turn of the observer, one of its timer. */
async function settle(): Promise<void> {
  await act(async () => { await pause(); await pause(); });
}
async function paint(view: HerdViewModel, variant: "page" | "rail" = "rail"): Promise<void> {
  act(() => renderReact(<HerdScreen view={view} actions={actions} variant={variant} />));
  await settle();
}
const controls = () => [...app().querySelectorAll<HTMLButtonElement>(".herd-list button")];
const stops = () => controls().filter(control => control.tabIndex === 0).map(name);
const name = (control: Element | null) => control instanceof HTMLElement
  ? control.getAttribute("aria-label") ?? control.dataset.paneId ?? control.textContent ?? "" : "";
const row = (paneId: string) => app().querySelector<HTMLButtonElement>(`.card-main[data-pane-id="${paneId}"]`)!;
const heading = (title: string) => [...app().querySelectorAll<HTMLButtonElement>(".group-title")].find(node => node.textContent === title)!;
const focused = () => name(document.activeElement);

/** A real key on whatever has focus; true when the list took it. */
function key(value: string, init: Record<string, unknown> = {}): boolean {
  const event = new happy.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  act(() => { document.activeElement!.dispatchEvent(event); });
  return event.defaultPrevented;
}
async function keys(...values: string[]): Promise<void> {
  for (const value of values) key(value);
  await settle();
}

let releaseZones = () => {};

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetInputMode();
  pointer(true);
  calls = [];
  releaseZones = bindKeyboardZones(document);
});

afterEach(() => {
  act(() => unmountReact());
  releaseZones();
  window.matchMedia = realMatchMedia;
  resetInputMode();
});

describe("one stop", () => {
  test("Tab has one place to arrive in the list: the open session's row, else the top", async () => {
    await paint(model({ selectedPaneId: "b1" }));
    expect(controls().length).toBeGreaterThan(12);
    expect(stops()).toEqual(["b1"]);
    await paint(model());
    expect(stops()).toEqual(["alpha"]);
    // The open session folded away with its group: the top again, never a row that is not drawn.
    await paint(model({ selectedPaneId: "b1", groupCollapsed: { beta: true } }));
    expect(stops()).toEqual(["alpha"]);
    // A flat list has no headings to stop at.
    await paint(model({ listGroup: "flat" }));
    expect(stops()).toEqual(["a1"]);
  });

  test("the control with focus is the stop, so the next Tab leaves from wherever the arrows went", async () => {
    await paint(model({ selectedPaneId: "b1" }));
    act(() => row("b1").focus());
    await keys("ArrowUp");
    expect(focused()).toBe("beta");
    expect(stops()).toEqual(["beta"]);
    await keys("ArrowDown", "ArrowRight");
    expect(focused()).toBe(t("list.swipePin"));
    expect(stops()).toEqual([t("list.swipePin")]);
    // Focus gone from the list: the stop is the open session's row again.
    act(() => (document.activeElement as HTMLElement).blur());
    await settle();
    expect(stops()).toEqual(["b1"]);
  });

  test("a row that arrives later adds no stop of its own", async () => {
    await paint(model({ selectedPaneId: "a1" }));
    await paint(model({ selectedPaneId: "a1", agents: [...herd, agent("c1", "gamma"), agent("a3", "alpha")] }));
    expect(stops()).toEqual(["a1"]);
  });

  test("the rest of the rail and the phone page keep their own stops", async () => {
    await paint(model({ selectedPaneId: "a1" }));
    for (const control of app().querySelectorAll<HTMLButtonElement>(".rail-head button, .rail-search, .rail-nav button")) {
      expect(control.hasAttribute("tabindex"), name(control)).toBeFalse();
    }
    pointer(false);
    await paint(model({ selectedPaneId: "a1" }), "page");
    for (const control of app().querySelectorAll<HTMLButtonElement>(".group-title, .card-main, .group-mark, .group-tool")) {
      expect(control.hasAttribute("tabindex"), name(control)).toBeFalse();
    }
    act(() => row("a1").focus());
    expect(key("ArrowDown")).toBeFalse();
    expectSameNode(document.activeElement, row("a1"));
  });
});

describe("the arrows", () => {
  test("Up and Down walk headings and rows across groups, past a folded group's rows; Home and End reach the ends", async () => {
    await paint(model({ groupCollapsed: { beta: true } }));
    act(() => heading("alpha").focus());
    const walk: string[] = [];
    for (const step of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "Home", "End", "ArrowUp"]) {
      await keys(step);
      walk.push(focused());
    }
    // The folded group is its heading only, and Down stops at the end.
    expect(walk).toEqual(["a1", "a2", "beta", "beta", "a2", "alpha", "beta", "a2"]);
  });

  test("Right goes into a row's own actions one at a time, Left comes back out, and Up or Down from one moves by rows", async () => {
    await paint(model());
    act(() => row("a2").focus());
    const walk: string[] = [];
    for (const step of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft"]) {
      await keys(step);
      walk.push(focused());
    }
    // A finished, unread row has "read" first.
    expect(walk).toEqual([t("list.swipeRead"), t("list.swipePin"), t("list.swipeMore"), t("list.swipeMore"),
      t("list.swipePin"), t("list.swipeRead"), "a2"]);
    await keys("ArrowRight", "ArrowUp");
    expect(focused()).toBe("a1");
    await keys("ArrowRight", "ArrowDown");
    expect(focused()).toBe("a2");
    expect(calls).toEqual([]);
  });

  test("on a heading Left folds and Right unfolds, then Right reaches its marks and tools; a row's Left goes to its heading", async () => {
    await paint(model());
    act(() => heading("alpha").focus());
    expect(key("ArrowLeft")).toBeTrue();
    expect(calls).toEqual(["toggle:alpha"]);
    await paint(model({ groupCollapsed: { alpha: true } }));
    // Folded already: Left has nothing left to do, and Right asks to unfold.
    calls = [];
    key("ArrowLeft");
    expect(calls).toEqual([]);
    key("ArrowRight");
    expect(calls).toEqual(["toggle:alpha"]);
    await paint(model());
    calls = [];
    const walk: string[] = [];
    for (const step of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft"]) {
      await keys(step);
      walk.push(focused());
    }
    expect(walk).toEqual([
      t("list.markBlockedAria", { count: "1" }), t("list.markDoneAria", { count: "1" }),
      t("list.newTabIn", { workspace: "alpha" }), t("list.workspaceMenu", { workspace: "alpha" }),
      t("list.workspaceMenu", { workspace: "alpha" }), t("list.newTabIn", { workspace: "alpha" }),
    ]);
    expect(calls).toEqual([]);
    act(() => row("a2").focus());
    await keys("ArrowLeft");
    expectSameNode(document.activeElement, heading("alpha"));
  });

  test("a + that cannot answer is passed over", async () => {
    await paint(model({ liveness: "unverifiable", runtimeKind: "" }));
    act(() => heading("beta").focus());
    await keys("ArrowRight");
    expect(focused()).toBe(t("list.workspaceMenu", { workspace: "beta" }));
  });

  test("a row that keeps its actions behind a swipe opens its menu on Right, as the context-menu key does", async () => {
    pointer(false);
    await paint(model());
    act(() => row("b1").focus());
    expect(key("ArrowRight")).toBeTrue();
    expect(calls).toEqual(["menu:b1"]);
    expectSameNode(document.activeElement, row("b1"));
    // Its swipe actions never became stops.
    expect(stops()).toEqual(["b1"]);
  });

  test("Enter, Space and Tab are the control's own, a letter is nobody's here, and a chord is not an arrow", async () => {
    await paint(model());
    act(() => row("a1").focus());
    for (const value of ["Enter", " ", "Tab", "v", "j", "/"]) expect(key(value), value).toBeFalse();
    for (const chord of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) expect(key("ArrowDown", chord)).toBeFalse();
    expectSameNode(document.activeElement, row("a1"));
    expect(calls).toEqual([]);
  });

  test("the press that opened a session left focus on its row: what is typed next is the session's, arrows included", async () => {
    await paint(model({ selectedPaneId: "a1" }));
    act(() => row("a1").focus());
    act(() => { noteKeydown(); noteSessionChosen(); });
    expect(key("ArrowDown")).toBeFalse();
    expectSameNode(document.activeElement, row("a1"));
    // The reader moves in the list again: the keys are the list's.
    act(() => heading("alpha").focus());
    act(() => row("a1").focus());
    expect(key("ArrowDown")).toBeTrue();
    expect(focused()).toBe("a2");
  });
});

describe("a row drawn again", () => {
  test("pinning from the keyboard moves the row to another group and the keyboard goes with it", async () => {
    await paint(model());
    act(() => row("b2").focus());
    await keys("ArrowRight");
    const pin = document.activeElement as HTMLButtonElement;
    expect(name(pin)).toBe(t("list.swipePin"));
    act(() => pin.click());
    expect(calls).toEqual(["pin:b2"]);
    await paint(model({ panePinned: { b2: 5 } }));
    // Another element in the pinned group: the same row's same action.
    const again = row("b2").closest(".card")!.querySelector<HTMLButtonElement>(".card-action.is-pin")!;
    expect(row("b2").closest(".herd-group") === heading("beta").closest(".herd-group")).toBeFalse();
    expect(pin.isConnected).toBeFalse();
    expectSameNode(document.activeElement, again);
    expect(stops()).toEqual([t("list.swipeUnpin")]);
  });

  test("a reader who pressed elsewhere is not called back when the list redraws their row", async () => {
    await paint(model());
    act(() => row("b2").focus());
    // A press on the session's screen: focus goes to the page, the row is still there.
    act(() => row("b2").blur());
    await settle();
    await paint(model({ panePinned: { b2: 5 } }));
    expectSameNode(document.activeElement, document.body);
  });
});

describe("the binding's lifetime", () => {
  /** The list's own markup, bound by hand: every frame and timer counted here is the binding's. */
  function rail(): { rail: HTMLElement; row: HTMLButtonElement; outside: HTMLButtonElement } {
    const node = document.createElement("aside");
    node.className = "rail";
    node.innerHTML = `<div class="herd-list"><section class="herd-group">
      <div class="group-head"><button class="group-title" data-trigger-of="g" aria-expanded="true">g</button></div>
      <div class="herd-group-body"><article class="card"><button class="card-main" data-pane-id="p1">p1</button></article></div>
    </section></div><button class="outside">out</button>`;
    document.body.append(node);
    return { rail: node, row: node.querySelector(".card-main")!, outside: node.querySelector(".outside")! };
  }

  test("released with focus still in the rail, it leaves no frame or timer waiting and focuses nothing afterwards", async () => {
    const real = { raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame, timeout: window.setTimeout };
    const waiting = new Set<number>();
    let timers = 0;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const id = real.raf((time) => { waiting.delete(id); callback(time); });
      waiting.add(id);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => { waiting.delete(id); real.cancel(id); }) as typeof cancelAnimationFrame;
    window.setTimeout = ((...args: Parameters<typeof setTimeout>) => { timers += 1; return real.timeout(...args); }) as typeof window.setTimeout;
    try {
      const { bindListKeys } = await import("./list-keys");
      const parts = rail();
      const release = bindListKeys(parts.rail);
      expect(parts.row.tabIndex).toBe(-1);
      parts.row.focus();
      // Focus moves on inside the rail: the stops are handed back a frame later.
      parts.outside.focus();
      expect(waiting.size).toBe(1);
      // The app unmounts before that frame: the rail leaves the page with its rows hanging from it.
      release();
      parts.rail.remove();
      expect(waiting.size).toBe(0);
      // A zero-delay timer left pending across a teardown is what stalled the next screen's own timers.
      expect(timers).toBe(0);
      let focused = 0;
      parts.row.focus = () => { focused += 1; };
      await pause();
      await pause();
      expect(focused).toBe(0);
      expectSameNode(document.activeElement, document.body);
      // And a change to the detached list is nobody's business any more.
      parts.rail.querySelector(".herd-group-body")!.append(document.createElement("article"));
      await pause();
      expect(parts.row.tabIndex).toBe(-1);
    } finally {
      globalThis.requestAnimationFrame = real.raf;
      globalThis.cancelAnimationFrame = real.cancel;
      window.setTimeout = real.timeout;
    }
  });

  test("a frame that arrives after the rail has left the page does nothing", async () => {
    const { bindListKeys } = await import("./list-keys");
    const parts = rail();
    const release = bindListKeys(parts.rail);
    parts.row.focus();
    parts.outside.focus();
    // Removed without a release (a parent torn down first): the frame still runs, and finds the rail gone.
    parts.rail.remove();
    let focused = 0;
    parts.row.focus = () => { focused += 1; };
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await pause();
    expect(focused).toBe(0);
    release();
  });
});

describe("what a screen reader is told", () => {
  test("the rail's rows are items of a named list; the phone page keeps the markup it has", async () => {
    await paint(model());
    const lists = [...app().querySelectorAll("[role='list']")];
    expect(lists.map(list => list.getAttribute("aria-label"))).toEqual(["alpha", "beta"]);
    expect(lists[0].querySelectorAll(":scope > [role='listitem']")).toHaveLength(2);
    // Still the buttons they were: a row opens, a heading says whether it is unfolded.
    expect(row("a1").tagName).toBe("BUTTON");
    expect(heading("alpha").getAttribute("aria-expanded")).toBe("true");
    pointer(false);
    await paint(model(), "page");
    expect(app().querySelector("[role='list'], [role='listitem']")).toBeNull();
  });
});
