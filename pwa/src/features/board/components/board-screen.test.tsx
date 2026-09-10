import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import { setLang, t } from "../../../lib/i18n";
import type { BoardSpace, BoardTab, TabLayout } from "../../../lib/layout";
import { appRoot } from "../../../app/dom-root";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { resetDashboard } from "../../dashboard/catalog-store";
import { setScreen } from "../../../app/navigation-store";
import { resetBoardCatalog } from "../layout-store";
import { buildBoardViewModel, type BoardModelInput, type BoardViewModel } from "../model/board-view";
import { BoardScreenView } from "./board-screen";
import type { BoardScreenActions } from "./board-screen";
import type { BoardCanvasController } from "./board-canvas";

const spaces: BoardSpace[] = [{ id: "w1", label: "alpha" }, { id: "w2", label: "beta" }];
const tabs: BoardTab[] = [
  { id: "w1:t1", workspaceId: "w1", label: "main" },
  { id: "w1:t2", workspaceId: "w1", label: "logs" },
];
const layout: TabLayout = {
  workspaceId: "w1",
  tabId: "w1:t1",
  zoomed: false,
  focusedPaneId: "w1:p1",
  area: { x: 0, y: 0, width: 100, height: 40 },
  panes: [{ paneId: "w1:p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }],
};

function agent(id: string, status: DashboardAgentCard["status"] = "idle"): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "claude", hasAgent: true, status, workspaceId: "w1",
    workspaceLabel: "alpha", tabId: "w1:t1", cwd: "/tmp/a",
  };
}

function model(overrides: Partial<BoardModelInput> = {}): BoardViewModel {
  return buildBoardViewModel({
    workspaceList: spaces,
    tabList: tabs,
    agents: [agent("w1:p1")],
    layouts: [layout],
    workspaceId: "w1",
    tabId: "w1:t1",
    selectedPaneId: "",
    status: { tone: "live", text: "已连接" },
    canCreateTab: true,
    operationBusy: false,
    connected: true,
    ...overrides,
  });
}

let calls: string[] = [];

const actions: BoardScreenActions = {
  back: () => calls.push("back"),
  selectWorkspace: (id) => calls.push(`workspace:${id}`),
  selectTab: (id) => calls.push(`tab:${id}`),
  createTab: () => calls.push("createTab"),
  fit: () => calls.push("fit"),
  zoom: (direction) => calls.push(`zoom:${direction}`),
};

function controller(id = ""): BoardCanvasController {
  return {
    applyTransform: () => calls.push(`transform${id}`),
    bindGestures: (_viewport, _stage, layout) => {
      calls.push(`bind${id}:${layout.area.width}`);
      return () => calls.push(`unbind${id}`);
    },
    registerHost: () => calls.push(`host${id}`),
    releaseHost: () => calls.push(`releaseHost${id}`),
    openPane: (paneId) => calls.push(`open:${paneId}`),
    zoomAt: () => calls.push("zoomAt"),
    releaseScrollOnLeave: () => calls.push(`releaseScroll${id}`),
    shareTileOpening: () => calls.push(`share${id}`),
  };
}

function paint(view: BoardViewModel, owner: BoardCanvasController = controller()): void {
  act(() => renderReact(<BoardScreenView view={view} actions={actions} controller={owner} />));
}

function chip(label: string): HTMLButtonElement {
  const found = [...appRoot().querySelectorAll<HTMLButtonElement>(".board-chip, .board-tab, .board-tab-new")]
    .find((node) => node.textContent === label);
  if (!found) throw new Error(`missing chip ${label}: ${appRoot().textContent?.slice(0, 200)}`);
  return found;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  // The pure presentation component receives everything through its props; the
  // baseline no longer needs the compatibility facade.
  setScreen("board");
  resetDashboard();
  calls = [];
});

afterEach(() => {
  act(() => unmountReact());
});

describe("board screen presentation", () => {
  test("the chrome and rails come from the model, not the live record", () => {
    const view = model();
    // The record is emptied before React runs: the props are the contract.
    resetDashboard();
    resetBoardCatalog();
    paint(view);
    expect(appRoot().querySelector(".board-name")?.textContent).toBe(t("board.title"));
    expect(appRoot().querySelector(".board-sub")?.textContent).toBe("alpha");
    expect([...appRoot().querySelectorAll(".board-chip")].map((node) => node.textContent)).toEqual(["alpha", "beta"]);
    expect([...appRoot().querySelectorAll(".board-tab")].map((node) => node.textContent)).toEqual([
      t("board.tabIndex", { n: 1 }), "logs",
    ]);
    expect(appRoot().querySelector(".board-chip.on")?.textContent).toBe("alpha");
    expect(appRoot().querySelector(".board-tab.on")?.textContent).toBe(t("board.tabIndex", { n: 1 }));
    expect(appRoot().querySelector(".board-chip.on")?.getAttribute("aria-selected")).toBe("true");
    expect(appRoot().querySelector(".board-chip.on")?.getAttribute("role")).toBe("tab");
    expect(appRoot().querySelectorAll(".board-pane")).toHaveLength(1);
  });

  test("every chrome control fires exactly one narrow action", () => {
    paint(model());
    act(() => appRoot().querySelector<HTMLButtonElement>(".board-chrome .back")!.click());
    act(() => chip("beta").click());
    act(() => chip("logs").click());
    act(() => chip(t("board.newTab")).click());
    const zoom = [...appRoot().querySelectorAll<HTMLButtonElement>(".board-zoom button")];
    act(() => zoom[0].click());
    act(() => zoom[1].click());
    act(() => zoom[2].click());
    const lifecycle = ["transform", "bind", "unbind", "host", "releaseHost", "share"];
    expect(calls.filter((call) => !lifecycle.some((name) => call.startsWith(name))))
      .toEqual(["back", "workspace:w2", "tab:w1:t2", "createTab", "zoom:-1", "fit", "zoom:1"]);
  });

  test("the zoom controls keep their labels and the fit button its visible copy", () => {
    paint(model());
    const zoom = [...appRoot().querySelectorAll<HTMLButtonElement>(".board-zoom button")];
    expect(zoom.map((node) => node.getAttribute("aria-label")))
      .toEqual([t("board.zoomOut"), t("board.fitAria"), t("board.zoomIn")]);
    expect(zoom[1].textContent).toBe(t("board.fit"));
    expect(zoom[0].textContent).toBe("−");
    expect(zoom[2].textContent).toBe("+");
  });

  test("new tab fails closed on capability, busy, connection and workspace", () => {
    paint(model({ canCreateTab: false }));
    expect(appRoot().querySelector(".board-tab-new")).toBeNull();
    paint(model({ operationBusy: true }));
    const busy = appRoot().querySelector<HTMLButtonElement>(".board-tab-new")!;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toBe(t("home.creating"));
    paint(model({ connected: false }));
    expect(appRoot().querySelector<HTMLButtonElement>(".board-tab-new")!.disabled).toBe(true);
    paint(model({ workspaceId: "" }));
    expect(appRoot().querySelector<HTMLButtonElement>(".board-tab-new")!.disabled).toBe(true);
    paint(model());
    expect(appRoot().querySelector<HTMLButtonElement>(".board-tab-new")!.disabled).toBe(false);
    expect(appRoot().querySelector<HTMLButtonElement>(".board-tab-new")!.textContent).toBe(t("board.newTab"));
  });

  test("an empty catalog explains itself and paints no stage", () => {
    paint(model({ workspaceList: [], tabList: [], layouts: [], agents: [], tabId: "" }));
    expect(appRoot().querySelector(".board-spaces .empty-sub")?.textContent).toBe(t("board.empty"));
    expect(appRoot().querySelector(".board-stage")).toBeNull();
    expect(appRoot().querySelector(".board-canvas .empty-title")?.textContent).toBe(t("board.emptyTitle"));
    // No stage means no camera write and no gesture binding at all.
    expect(calls).toContain("host");
    expect(calls).not.toContain("transform");
    expect(calls).not.toContain("bind");
  });

  test("the status line and banners follow the projected tone", () => {
    paint(model({ status: { tone: "off", text: t("chrome.herdrOff") } }));
    expect(appRoot().querySelector(".statusline .dot-off")).not.toBeNull();
    expect(appRoot().querySelector(".statusline-text")?.textContent).toBe(t("chrome.herdrOff"));
    expect(appRoot().querySelector(".banner-off")?.textContent).toBe(t("chrome.herdrOffBanner"));
    paint(model({ status: { tone: "live", text: "已连接" } }));
    expect(appRoot().querySelector(".banner-off")).toBeNull();
  });

  test("leaving the board asks the controller to release the remote scroll once", () => {
    paint(model());
    expect(calls).not.toContain("releaseScroll");
    act(() => unmountReact());
    expect(calls.filter((call) => call === "releaseScroll")).toEqual(["releaseScroll"]);
    expect(calls).toContain("releaseHost");
  });

  test("a replaced controller takes over the canvas and releases its own scroll lifetime", () => {
    const first = controller(":A");
    const second = controller(":B");
    paint(model(), first);
    expect(calls).toContain("bind:A:100");
    paint(model(), second);
    expect(calls).toContain("unbind:A");
    expect(calls).toContain("bind:B:100");
    expect(calls).toContain("releaseHost:A");
    // Retiring a setup releases the scroll lifetime it owned, and only that one.
    expect(calls.filter((call) => call.startsWith("releaseScroll"))).toEqual(["releaseScroll:A"]);
    act(() => unmountReact());
    expect(calls.filter((call) => call.startsWith("releaseScroll")))
      .toEqual(["releaseScroll:A", "releaseScroll:B"]);
  });
});
