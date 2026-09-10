import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { HerdPaint } from "../../../lib/herd-attention";
import { setLang, t } from "../../../lib/i18n";
import { PINNED_GROUP_ID } from "../../../lib/ranking";
import { appRoot } from "../../../app/dom-root";
import { clearNotice, showStatus } from "../../../app/notices-store";
import { setOperationBusy } from "../../operations/capabilities-store";
import { selectPane } from "../../session/session-store";
import { replaceAgentsFromSnapshot } from "../catalog-store";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import type { HerdActions } from "../actions";

const app = appRoot;
import { buildHerdViewModel, type HerdModelInput, type HerdViewModel } from "../model/herd-view";
import { HerdScreen } from "./herd-screen";

function agent(id: string, workspace: string, status: DashboardAgentCard["status"] = "idle"): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status,
    workspaceId: workspace, workspaceLabel: workspace, cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab`,
  };
}

const noAttention: HerdPaint = { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] };

function model(overrides: Partial<HerdModelInput> = {}): HerdViewModel {
  return buildHerdViewModel({
    agents: [agent("p1", "alpha"), agent("p2", "beta", "working")],
    listGroup: "flat",
    paneTouched: {},
    panePinned: {},
    groupCollapsed: {},
    selectedPaneId: "p1",
    attention: noAttention,
    liveness: "live",
    status: { tone: "live", text: "已连接" },
    connected: true,
    networkOnline: true,
    runtimeKind: "herdr",
    createConversation: true,
    operationBusy: false,
    computerCount: 1,
    morphingPaneId: null,
    ...overrides,
  });
}

let calls: string[] = [];

const actions: HerdActions = {
  openPaneFromCard: (paneId, title) => calls.push(`openPane:${paneId}:${title?.className ?? "no-title"}`),
  openPaneMenu: (card) => calls.push(`paneMenu:${card.paneId}`),
  openWorkspaceMenu: (card) => calls.push(`workspaceMenu:${card?.paneId ?? "none"}`),
  toggleGroup: (groupId, groupIds) => calls.push(`toggle:${groupId}:${groupIds.join(",")}`),
  createConversation: () => calls.push("create"),
  openBoard: () => calls.push("board"),
  openSettings: () => calls.push("settings"),
  openComputers: () => calls.push("computers"),
  runEmptyAction: (kind) => calls.push(`empty:${kind}`),
};

function paint(view: HerdViewModel, variant: "page" | "rail" = "page"): void {
  act(() => renderReact(<HerdScreen view={view} actions={actions} variant={variant} />));
}

function cardMain(name: string): HTMLButtonElement {
  const found = [...app().querySelectorAll<HTMLButtonElement>(".card-main")].find((node) => node.textContent?.includes(name));
  if (!found) throw new Error(`missing card ${name}: ${app().textContent?.slice(0, 200)}`);
  return found;
}

function hold(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  calls = [];
  clearNotice();
});

afterEach(() => {
  act(() => unmountReact());
  clearNotice();
});

describe("herd screen presentation", () => {
  test("the screen renders the model it was handed, not the live record", () => {
    const view = model();
    // The live domains move on before React runs: empty herd, busy, a different
    // selection. The screen must still render exactly the props it was handed —
    // these four assertions reject a regression that reads global state instead.
    act(() => {
      replaceAgentsFromSnapshot({ panes: [] });
      setOperationBusy(true);
      selectPane("other");
    });
    paint(view);
    expect([...app().querySelectorAll(".card-name")].map((node) => node.textContent)).toEqual(["p1", "p2"]);
    expect(app().querySelectorAll(".card.sel")).toHaveLength(1);
    expect(app().querySelector(".card.status-working")).not.toBeNull();
    expect(app().querySelector<HTMLButtonElement>(".topbar-create")?.disabled).toBe(false);
  });

  test("the page carries notices above the list, the desktop rail carries none", () => {
    act(() => showStatus("notice above cards", true));
    paint(model(), "page");
    expect(app().firstElementChild?.className).toBe("page");
    const children = [...app().querySelector(".page")!.children];
    const noticeAt = children.findIndex((node) => node.matches("[data-react-notice]"));
    const listAt = children.findIndex((node) => node.matches(".herd-list"));
    expect(noticeAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(noticeAt);
    expect(children[noticeAt].textContent).toBe("notice above cards");
    expect(children.map((node) => node.className).slice(0, 2)).toEqual(["topbar", "statusline"]);
    paint(model(), "rail");
    expect(app().firstElementChild?.className).toBe("rail");
    expect(app().querySelector(".rail [data-react-notice]")).toBeNull();
    expect(app().querySelector(".rail .herd-list")).not.toBeNull();
    expect(app().querySelector(".rail .topbar")).not.toBeNull();
  });

  test("a card click opens its pane with the title element, a hold asks for the pane menu", () => {
    paint(model());
    act(() => cardMain("p1").click());
    expect(calls).toEqual(["openPane:p1:card-title"]);
    calls = [];
    hold(cardMain("p2"));
    expect(calls).toEqual(["paneMenu:p2"]);
  });

  test("grouped mode toggles through the action and only a workspace heading owns a menu", () => {
    paint(model({
      listGroup: "space",
      agents: [agent("p1", "alpha"), agent("p2", "beta")],
      panePinned: { p2: 4 },
      groupCollapsed: {},
    }));
    const headings = [...app().querySelectorAll<HTMLButtonElement>(".group-title")];
    expect(headings.map((node) => node.getAttribute("aria-haspopup"))).toEqual([null, "menu"]);
    expect(headings.map((node) => node.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    act(() => headings[1].click());
    // The fold carries the order this list was rendered from, not the record's.
    expect(calls).toEqual([`toggle:alpha:${PINNED_GROUP_ID},alpha`]);
    calls = [];
    hold(headings[0]);
    expect(calls).toEqual([]);
    hold(headings[1]);
    expect(calls).toEqual(["workspaceMenu:p1"]);
  });

  test("flat mode keeps bare section titles and the stagger indices", () => {
    paint(model({ attention: { ...noAttention, stagger: true } }));
    expect(app().querySelector(".herd-list")?.className).toBe("herd-list enter");
    expect(app().querySelector(".group-title")).toBeNull();
    expect([...app().querySelectorAll<HTMLElement>(".section-title, .card")].map((node) => node.style.getPropertyValue("--i")))
      .toEqual(["0", "1", "2"]);
  });

  test("the empty state runs the action kind the model chose", () => {
    paint(model({ agents: [], createConversation: false, connected: false, networkOnline: false }));
    expect(app().querySelector(".herd-list")).toBeNull();
    const action = app().querySelector<HTMLButtonElement>(".empty-action")!;
    expect(action.textContent).toBe(t("empty.actionRetry"));
    act(() => action.click());
    expect(calls).toEqual(["empty:retry"]);
  });

  test("the topbar fires one narrow action per control and follows the model gates", () => {
    paint(model({ computerCount: 2 }));
    act(() => app().querySelector<HTMLButtonElement>(".topbar-create")!.click());
    const links = () => [...app().querySelectorAll<HTMLButtonElement>(".topbar-actions .text-link")];
    act(() => links()[0].click());
    act(() => links()[1].click());
    act(() => links()[2].click());
    expect(calls).toEqual(["create", "computers", "board", "settings"]);
    calls = [];
    paint(model({ createConversation: false, computerCount: 1, operationBusy: true }));
    expect(app().querySelector(".topbar-create")).toBeNull();
    expect([...app().querySelectorAll(".topbar-actions button")]).toHaveLength(2);
  });

  test("the status line keeps its tone, text and completion count", () => {
    paint(model({ agents: [agent("p1", "alpha", "done"), agent("p2", "beta", "done")], status: { tone: "warn", text: t("chrome.unverifiable") } }));
    expect(app().querySelector(".statusline .dot-warn")).not.toBeNull();
    expect(app().querySelector(".statusline-text")?.textContent).toBe(t("chrome.unverifiable"));
    expect(app().querySelector(".done-count")?.textContent).toBe(t("home.doneCount", { count: "2" }));
    paint(model({ agents: [agent("p1", "alpha", "idle")] }));
    expect(app().querySelector(".done-count")).toBeNull();
  });
});
