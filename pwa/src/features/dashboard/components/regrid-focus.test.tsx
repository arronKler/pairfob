import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { HerdPaint } from "../../../lib/herd-attention";
import { setLang } from "../../../lib/i18n";
import type { HerdActions } from "../actions";
import { buildHerdViewModel, type HerdViewModel } from "../model/herd-view";
import { HerdScreen } from "./herd-screen";

/**
 * The keyboard's place in the list when the window crosses the desk tier: the
 * rail and the phone page are different elements, and the row that held focus
 * hands it to its own instance in the list that is drawn next.
 */
function agent(id: string, workspace: string): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status: "idle",
    workspaceId: workspace, workspaceLabel: workspace, workspaceCwd: `/work/${workspace}`,
    cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab`,
  };
}

const noAttention: HerdPaint = { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] };

function model(): HerdViewModel {
  return buildHerdViewModel({
    agents: [agent("p1", "alpha"), agent("p2", "alpha"), agent("p3", "beta")],
    listGroup: "space", paneTouched: {}, paneActivated: {}, panePinned: {}, groupCollapsed: {}, selectedPaneId: "p1",
    attention: noAttention, liveness: "live", status: { tone: "live", text: "已连接" }, reading: false, snapshotLoaded: true,
    recentDirs: [], connected: true, networkOnline: true, runtimeKind: "herdr", createConversation: true, operationBusy: false,
    morphingPaneId: null, host: { name: "studio", line: "已连接 · P2P 直连 · 18 毫秒", tone: "live" }, createTab: true, now: 10 * 60_000,
  });
}

const actions = new Proxy({}, { get: () => () => {} }) as HerdActions;
const app = appRoot;
const row = (paneId: string) => app().querySelector<HTMLElement>(`.card-main[data-pane-id="${paneId}"]`)!;

/** The shell at a width: the rail beside a page, the phone's list page, or a phone page with no list (an open session). */
function shell(width: number, list = true): void {
  happy.happyDOM.setWindowSize({ width, height: 800 });
  const variant = width >= 720 ? "rail" : "page";
  act(() => renderReact(list ? <HerdScreen key={variant} view={model()} actions={actions} variant={variant} /> : <main><button>Send</button></main>));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(() => {
  act(() => unmountReact());
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("a focused row keeps focus from the rail to the phone page and back", () => {
  shell(1024);
  const railRow = row("p2");
  railRow.focus();
  shell(700);
  expect(app().querySelector(".rail")).toBeNull();
  expect(railRow.isConnected).toBeFalse();
  expectSameNode(document.activeElement, row("p2"));
  const pageRow = row("p2");
  shell(1024);
  expect(pageRow.isConnected).toBeFalse();
  expectSameNode(document.activeElement, row("p2"));
});

test("a focused heading is found again by the workspace it names", () => {
  shell(1024);
  const title = () => [...app().querySelectorAll<HTMLElement>(".group-title")].find(node => node.textContent?.includes("beta"))!;
  title().focus();
  shell(700);
  expectSameNode(document.activeElement, title());
  shell(1024);
  expectSameNode(document.activeElement, title());
});

test("a layout with no list in it keeps the row for the rail's return while focus is nowhere", () => {
  shell(1024);
  row("p3").focus();
  shell(700, false);
  expectSameNode(document.activeElement, document.body);
  shell(1024);
  expectSameNode(document.activeElement, row("p3"));
});

test("a control the reader focused meanwhile is not taken from them", () => {
  shell(1024);
  row("p3").focus();
  shell(700, false);
  const send = app().querySelector("button")!;
  send.focus();
  send.blur();
  shell(1024);
  expectSameNode(document.activeElement, document.body);
});

test("a list that leaves without a regrid hands nothing over: the phone's own navigation is as it was", () => {
  shell(390);
  row("p2").focus();
  // The row opened its session: the list page leaves at the same width.
  shell(390, false);
  shell(390);
  expectSameNode(document.activeElement, document.body);
  // The same on the desk: the rail going away at a desk width is not a regrid either.
  shell(1024);
  row("p2").focus();
  shell(1024, false);
  shell(1024);
  expectSameNode(document.activeElement, document.body);
});

test("focus outside the list is not the list's to hand over", () => {
  shell(1024);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  shell(700);
  expectSameNode(document.activeElement, outside);
  outside.remove();
});
