import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardAgentCard } from "../../lib/dashboard";
import { noteCompletionAcknowledged, resetHerdAttention } from "../../lib/herd-attention";
import { setLang, t } from "../../lib/i18n";
import { PINNED_GROUP_ID } from "../../lib/ranking";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { CreateWorktreeResult } from "../../lib/operations";
import { dismissWorktreeJob, startWorktreeJob, worktreeJobs, type WorktreeJobDriver } from "../../lib/worktree-jobs";
import { app, clearNotice, showStatus, state } from "../../state";
import { setRenderer } from "../../paint";
import { nextTransition, takeTransition, withTransition } from "../transition";
import { renderApp } from "./app-screen";
import { leaveReactScreen } from "./root";

let connected = true;
const vibrations: number[] = [];
const originalVibrate = Object.getOwnPropertyDescriptor(happy.navigator, "vibrate");

function agent(id: string, workspace = "alpha", status: DashboardAgentCard["status"] = "idle"): DashboardAgentCard {
  return { paneId: id, paneLabel: id, workspaceId: workspace, workspaceLabel: workspace,
    tabId: `${workspace}:tab`, cwd: `/work/${workspace}`, agent: "codex", hasAgent: true, status };
}

function paint(): void { act(renderApp); }
function button(label: string, host: ParentNode = app): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function menu(target: HTMLElement): void {
  act(() => { target.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); });
}
async function menuTask(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => window.setTimeout(resolve, 0));
}
function reactOwned(element: Element): boolean {
  return Object.keys(element).some(key => key.startsWith("__reactFiber$"));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  connected = true;
  vibrations.length = 0;
  Object.defineProperty(happy.navigator, "vibrate", { configurable: true, value: (duration: number) => { vibrations.push(duration); return true; } });
  Object.assign(state, { phase: "live", screen: "home", credential: null, computers: [], paneId: "", agents: [],
    listGroup: "flat", listGroupCollapsed: {}, paneTouched: {}, panePinned: {}, runtimeKind: "herdr", herdHost: "",
    networkOnline: true, operationBusy: false, agentChat: false, fullTerminal: false, settingsLoading: false,
    deviceList: [], devicesError: "", pushConfigError: "", agentKinds: [] });
  state.operationCapabilities = { ...state.operationCapabilities, create_conversation: false, create_tab: false };
  state.live = { isConnected: () => connected } as LiveSession;
  resetHerdAttention();
  clearNotice();
  setLang("zh");
  setRenderer(renderApp);
});

afterEach(async () => {
  await act(() => leaveReactScreen());
  setRenderer(() => {});
  for (const job of [...worktreeJobs()]) dismissWorktreeJob(job.id);
  await act(async () => { closeTestDialogs(); await menuTask(); });
  clearNotice();
  resetHerdAttention();
  state.phase = "boot";
  state.live = null;
  state.paneId = "";
  if (originalVibrate) Object.defineProperty(happy.navigator, "vibrate", originalVibrate);
  else delete (happy.navigator as unknown as { vibrate?: unknown }).vibrate;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});

describe("React herd list", () => {
  test("pinned and workspace groups keep ordering, accordion state, focus, and card identity", () => {
    state.agents = [agent("p1"), agent("p2", "beta"), agent("p3", "gamma")];
    state.panePinned = { p3: 1 };
    state.paneTouched = { p1: 30, p2: 20 };
    state.listGroup = "space";
    paint();
    expect(reactOwned(app.firstElementChild!)).toBe(true);
    expect([...app.querySelectorAll(".group-name")].map(node => node.textContent)).toEqual([t("group.pinned"), "alpha", "beta"]);
    expect(state.listGroupCollapsed).toEqual({ [PINNED_GROUP_ID]: false, alpha: false, beta: true });
    const headings = [...app.querySelectorAll<HTMLButtonElement>(".group-title")];
    expect(headings.map(node => node.getAttribute("aria-haspopup"))).toEqual([null, "menu", "menu"]);
    const cards = [...app.querySelectorAll<HTMLElement>(".card")];
    expect(cards[0].classList.contains("pinned")).toBe(true);
    expect([...app.querySelectorAll<HTMLElement>(".group-title, .card")].map(node => node.style.getPropertyValue("--i")))
      .toEqual(["0", "1", "2", "3", "4", "5"]);
    headings[2].focus();
    act(() => headings[2].click());
    expect(state.listGroupCollapsed.beta).toBe(false);
    expect(app.querySelectorAll(".group-title")[2]).toBe(headings[2]);
    expect(document.activeElement).toBe(headings[2]);
    expect(app.querySelectorAll(".card")[2]).toBe(cards[2]);
    expect((app.querySelectorAll(".herd-group-body")[2] as HTMLElement).hidden).toBe(false);
    paint();
    expect(state.listGroupCollapsed.beta).toBe(false);
  });

  test("unverifiable cards retain their known rows while replacing stale status pills", () => {
    state.agents = [agent("p1", "alpha", "done")];
    state.paneId = "p1";
    connected = false;
    paint();
    const card = app.querySelector(".card")!;
    expect(card.classList.contains("unverifiable")).toBe(true);
    expect(card.classList.contains("sel")).toBe(true);
    expect(card.querySelector(".card-main")?.getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector(".pill-unknown")?.textContent).toBe(t("status.unverifiable"));
    expect(card.querySelector(".pill-done")).toBeNull();
    expect(app.querySelector(".done-count")).not.toBeNull();
  });

  test("a visible completion batch vibrates once and keeps attention through repaint", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    state.agents = [agent("p1", "alpha", "working"), agent("p2", "beta", "working")];
    paint();
    expect(vibrations).toEqual([]);
    state.agents = state.agents.map(item => ({ ...item, status: "done" }));
    paint();
    expect(vibrations).toEqual([14]);
    expect(app.querySelectorAll(".card.ac-done")).toHaveLength(2);
    paint();
    act(() => showStatus("local notice", true));
    expect(vibrations).toEqual([14]);
    noteCompletionAcknowledged("p1");
    paint();
    expect(app.querySelector(".card.attn-out")).not.toBeNull();
  });

  test("background completions do not vibrate", () => {
    state.agents = [agent("p1", "alpha", "working")];
    paint();
    state.agents = [agent("p1", "alpha", "done")];
    paint();
    expect(vibrations).toEqual([]);
  });

  test("card menus use fresh data, honor busy and connection guards, and release native bindings", async () => {
    state.agents = [agent("p1")];
    paint();
    const card = app.querySelector<HTMLButtonElement>(".card-main")!;
    state.agents = [{ ...state.agents[0], paneLabel: "Renamed pane" }];
    paint();
    expect(app.querySelector(".card-main")).toBe(card);
    state.operationBusy = true;
    menu(card);
    expect(document.querySelector("dialog")).toBeNull();
    state.operationBusy = false;
    connected = false;
    menu(card);
    expect(document.querySelector("dialog")).toBeNull();
    connected = true;
    card.focus();
    menu(card);
    expect(document.querySelector(".modal-title")?.textContent).toContain("Renamed pane");
    const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
    act(() => dialog.close());
    await act(() => leaveReactScreen());
    document.body.append(card);
    menu(card);
    expect(document.querySelector("dialog")).toBeNull();
    card.remove();
  });

  test("new-session availability follows its capability, connection, and busy state", () => {
    paint();
    expect(app.querySelector(".topbar-create")).toBeNull();
    state.operationCapabilities.create_conversation = true;
    paint();
    expect(app.querySelector<HTMLButtonElement>(".topbar-create")?.disabled).toBe(false);
    state.operationBusy = true;
    paint();
    expect(app.querySelector<HTMLButtonElement>(".topbar-create")?.disabled).toBe(true);
    expect(app.querySelector(".topbar-create")?.textContent).toBe(t("home.creating"));
    state.operationBusy = false;
    connected = false;
    paint();
    expect(app.querySelector<HTMLButtonElement>(".topbar-create")?.disabled).toBe(true);
  });

  test("pin and unpin menu actions regroup the current React list", async () => {
    state.agents = [agent("p1"), agent("p2")];
    paint();
    menu(app.querySelector<HTMLButtonElement>(".card-main")!);
    await act(async () => {
      button(t("menu.pin"), document.querySelector("dialog")!).click();
      await menuTask();
    });
    expect(state.panePinned.p1).toBeGreaterThan(0);
    expect(app.querySelectorAll(".card.pinned")).toHaveLength(1);
    expect(app.querySelector(".section-title")?.textContent).toBe(`${t("group.pinned")}1`);
    menu(app.querySelector<HTMLButtonElement>(".card.pinned .card-main")!);
    await act(async () => {
      button(t("menu.unpin"), document.querySelector("dialog")!).click();
      await menuTask();
    });
    expect(state.panePinned.p1).toBeUndefined();
    expect(app.querySelector(".card.pinned")).toBeNull();
    expect(app.querySelectorAll(".section-title")).toHaveLength(1);
  });
});

test("worktree cards retry only on request and cancel locally before a late result", async () => {
  const pending: Array<{ resolve: (result: CreateWorktreeResult) => void; reject: (error: Error) => void }> = [];
  const events: string[] = [];
  const driver: WorktreeJobDriver = {
    create: () => new Promise((resolve, reject) => { events.push("create"); pending.push({ resolve, reject }); }),
    refresh: async () => { events.push("refresh"); }, openPane: async () => { events.push("open"); },
    reconcile: async () => { events.push("reconcile"); }, messageOf: error => String(error), repaint: renderApp,
  };
  act(() => { startWorktreeJob(driver, { workspace_id: "alpha", branch: "feature/review", path: "/work/review" }); });
  expect(app.querySelector(".worktree-job-working .spinner")).not.toBeNull();
  expect([...app.querySelector(".page")!.children].map(node => node.className).slice(-3))
    .toEqual(["worktree-jobs", "seg", "empty"]);
  await act(async () => { pending[0].reject(new Error("fetch failed")); await Promise.resolve(); });
  expect(app.querySelector(".worktree-job-error")?.textContent).toContain("fetch failed");
  expect(events.filter(event => event === "create")).toHaveLength(1);
  act(() => button(t("retry"), app.querySelector(".worktree-job")!).click());
  expect(events.filter(event => event === "create")).toHaveLength(2);
  expect(app.querySelector(".worktree-job-working")).not.toBeNull();
  act(() => button(t("cancel"), app.querySelector(".worktree-job")!).click());
  expect(app.querySelector(".worktree-jobs")).toBeNull();
  await act(async () => { pending[1].resolve({ operation_id: "op_AAECAwQFBgcICQoL", workspace_id: "alpha",
    tab_id: "alpha:tab", pane_id: "new", path: "/work/review", branch: "feature/review", outcome: "applied" }); });
  expect(events).toEqual(["create", "reconcile", "create"]);
});

describe("React desktop routing", () => {
  test("the empty desktop keeps its rail and separates main-pane notices", () => {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    state.agents = [agent("p1")];
    showStatus("choose a pane", true);
    paint();
    expect([...app.children].map(node => node.className)).toEqual(["rail", "main"]);
    expect([...app.children].every(reactOwned)).toBe(true);
    expect(app.classList.contains("desk")).toBe(true);
    expect(app.querySelector(".rail .notice")).toBeNull();
    expect(app.querySelector(".main .notice")?.textContent).toBe("choose a pane");
    expect(app.querySelector(".main-empty")).not.toBeNull();
    expect(app.querySelectorAll(".daemon-update-host")).toHaveLength(1);
    expect(app.querySelector(".rail .daemon-update-host + .seg")).not.toBeNull();
  });

  test("desktop settings pages take precedence over a remembered selected pane", () => {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    state.agents = [agent("p1")];
    state.paneId = "p1";
    for (const screen of ["settings", "quota", "computers"] as const) {
      state.screen = screen;
      paint();
      expect(reactOwned(app.firstElementChild!)).toBe(true);
      expect(app.querySelector(".main.main-settings")).not.toBeNull();
      expect(app.querySelector(".pane-root")).toBeNull();
    }
  });

  test("desktop navigation resets the main scroll while same-page repaint retains it", () => {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    state.screen = "quota";
    paint();
    const main = app.querySelector<HTMLElement>(".main")!;
    main.scrollTop = 280;
    paint();
    expect(app.querySelector(".main")).toBe(main);
    expect(main.scrollTop).toBe(280);
    state.screen = "settings";
    paint();
    expect(app.querySelector<HTMLElement>(".main")?.scrollTop).toBe(0);
  });
});

test("the incoming card title stops sharing a transition name after the transition finishes", async () => {
  state.agents = [agent("p1")];
  nextTransition("pop", "p1");
  const transitionDocument = document as Document & { startViewTransition?: (paint: () => void) => { finished: Promise<void> } };
  const original = transitionDocument.startViewTransition;
  transitionDocument.startViewTransition = update => { update(); return { finished: Promise.resolve() }; };
  try {
    act(() => withTransition(takeTransition(), renderApp));
    const title = app.querySelector<HTMLElement>(".card-title")!;
    expect(title.style.viewTransitionName).toBe("pane-title");
    await act(async () => { await Promise.resolve(); });
    paint();
    expect(app.querySelector(".card-title")).toBe(title);
    expect(title.style.viewTransitionName).toBe("");
  } finally {
    transitionDocument.startViewTransition = original;
  }
});
