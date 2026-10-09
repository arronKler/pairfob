import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { setLang, t } from "../../../lib/i18n";
import { appRoot } from "../../../app/dom-root";
import { bindOverlayOrigin } from "../../../shared/ui/overlay/origin";
import type { HerdActions } from "../actions";
import { buildHerdViewModel, type HerdViewModel } from "../model/herd-view";
import { HerdList } from "./herd-list";
import { openObjectMenu } from "./object-menu";

/**
 * A menu opened from a rail row, or from a workspace heading, stays that row's
 * across a window round trip: the shell draws the list again, every row has the
 * same "more", and the menu finds its own by the session the control names.
 */
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const realMatchMedia = window.matchMedia;
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
let release = () => {};

function agent(id: string, workspace: string): DashboardAgentCard {
  return { paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status: "idle", workspaceId: workspace,
    workspaceLabel: workspace, workspaceCwd: `/work/${workspace}`, cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab` };
}
const everyone = [agent("p1", "alpha"), agent("p2", "alpha"), agent("p3", "beta")];

function model(agents: DashboardAgentCard[]): HerdViewModel {
  return buildHerdViewModel({
    agents, listGroup: "space", paneTouched: {}, paneActivated: {}, panePinned: {}, groupCollapsed: {}, selectedPaneId: "p1",
    attention: { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] },
    liveness: "live", status: { tone: "live", text: "live" }, reading: false, snapshotLoaded: true, recentDirs: [],
    connected: true, networkOnline: true, runtimeKind: "herdr", createConversation: true, operationBusy: false,
    morphingPaneId: null, host: { name: "studio", line: "", tone: "live" }, createTab: true, now: 10 * 60_000,
  });
}

/** The menu the page opens, through the dashboard's own presenter. */
const menu = (card: { paneId: string }) => openObjectMenu(
  { title: card.paneId, facts: [], items: [{ kind: "pin", label: t("menu.pin"), scope: "pane" }] }, card as DashboardAgentCard, () => {});
const actions = new Proxy({ openPaneMenu: menu, openWorkspaceMenu: menu }, {
  get: (known, name) => (known as Record<string | symbol, unknown>)[name] ?? (() => {}),
}) as unknown as HerdActions;

/** Draw the rail's list from scratch, as the shell does when the window crosses a tier. */
function draw(agents = everyone): void {
  act(() => unmountReact());
  act(() => renderReact(<div className="rail"><HerdList view={model(agents)} actions={actions} variant="rail" /></div>));
  // Happy DOM lays nothing out: every control a menu can hang from gets a box of its own.
  [...appRoot().querySelectorAll<HTMLElement>("[data-trigger-of]")].forEach((node, index) => {
    const top = 40 + index * 30;
    node.getBoundingClientRect = () => ({ left: 240, top, right: 268, bottom: top + 28, width: 28, height: 28, x: 240, y: top, toJSON() {} });
  });
}
const more = (paneId: string) => [...appRoot().querySelectorAll<HTMLButtonElement>(".card-action.is-more")]
  .find(node => node.getAttribute("data-trigger-of") === paneId)!;
const row = (paneId: string) => appRoot().querySelector<HTMLButtonElement>(`.card-main[data-pane-id="${paneId}"]`)!;

async function resize(width: number): Promise<void> {
  happy.happyDOM.setWindowSize({ width, height: 700 });
  await act(async () => {
    window.dispatchEvent(new happy.Event("resize") as unknown as Event);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await pause();
  });
}
function click(target: HTMLElement): void {
  target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", clientX: 250, clientY: 80 }) as unknown as Event);
  act(() => target.click());
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  happy.happyDOM.setWindowSize({ width: 800, height: 700 });
  window.matchMedia = ((query: string) => query === FINE_POINTER
    ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
    : realMatchMedia.call(window, query)) as typeof window.matchMedia;
  release = bindOverlayOrigin(document);
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  act(() => unmountReact());
  release();
  window.matchMedia = realMatchMedia;
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("the controls a menu hangs from say which session or workspace they are for", () => {
  draw();
  const named = (selector: string) => [...appRoot().querySelectorAll(selector)].map(node => node.getAttribute("data-trigger-of"));
  expect(named(".card-main")).toEqual(["p1", "p2", "p3"]);
  expect(named(".card-action.is-more")).toEqual(["p1", "p2", "p3"]);
  // Pin acts at once and opens nothing.
  expect(named(".card-action.is-pin")).toEqual([null, null, null]);
  const groups = [...appRoot().querySelectorAll(".group-head")];
  expect(groups).toHaveLength(2);
  for (const head of groups) {
    const id = head.querySelector(".group-title")!.getAttribute("data-trigger-of");
    expect(id).toBeTruthy();
    expect(head.querySelector(".group-tool[aria-haspopup]")!.getAttribute("data-trigger-of")).toBe(id);
    // The heading's other tool opens the create dialog: its own key, so two
    // workspaces of one name still tell their + apart.
    const create = head.querySelector(".group-tool:not([aria-haspopup])");
    if (create) expect(create.getAttribute("data-trigger-of")).toBe(`${id}:create`);
  }
  expect(new Set(named(".group-title")).size).toBe(2);
});

test("a row's menu hangs from the same row after the list was drawn again, and closing returns focus to it", async () => {
  draw();
  click(more("p2"));
  const dialog = sheet();
  expect(dialog.className).toBe("modal sheet popover popover-menu object-menu-sheet");
  expect(more("p2").getAttribute("data-popover-open")).toBe("menu");
  await resize(700);
  expect(dialog.className).toBe("modal sheet object-menu-sheet");
  const before = more("p2");
  draw();
  expect(before.isConnected).toBe(false);
  await resize(800);
  expect(dialog.open).toBe(true);
  expect(dialog.className).toBe("modal sheet popover popover-menu object-menu-sheet");
  expect([...appRoot().querySelectorAll(".card-action.is-more")].map(node => node.getAttribute("data-popover-open"))).toEqual([null, "menu", null]);
  expect(dialog.style.top).toBe(`${more("p2").getBoundingClientRect().bottom + 6}px`);
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, more("p2"));
});

test("the session closed while its menu was open: the menu is the card and focus returns to the list", async () => {
  draw();
  click(more("p2"));
  const dialog = sheet();
  await resize(700);
  draw(everyone.filter(card => card.paneId !== "p2"));
  await resize(800);
  expect(dialog.open).toBe(true);
  expect(dialog.className).toBe("modal sheet desk-form object-menu-sheet");
  expect(appRoot().querySelector("[data-popover-open]")).toBeNull();
  await act(async () => { closeTestDialogs(); await pause(); });
  // The row the reader is on; no other row's "more" stands in for the one that left.
  expectSameNode(document.activeElement, row("p1"));
});

test("a workspace heading's menu hangs from that heading's tool again", async () => {
  draw();
  const tool = () => appRoot().querySelectorAll<HTMLButtonElement>(".group-tool[aria-haspopup]")[1];
  click(tool());
  const dialog = sheet();
  expect(dialog.className).toBe("modal sheet popover popover-menu object-menu-sheet");
  await resize(700);
  draw();
  await resize(800);
  expect(dialog.className).toBe("modal sheet popover popover-menu object-menu-sheet");
  expect(tool().getAttribute("data-popover-open")).toBe("menu");
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, tool());
});
