import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { expectSameNode } from "../../../../test-support/node-identity";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { HerdPaint } from "../../../lib/herd-attention";
import { setLang } from "../../../lib/i18n";
import type { HerdActions, ReadAllReceipt } from "../actions";
import { buildHerdViewModel, type HerdViewModel } from "../model/herd-view";
import { HerdScreen } from "./herd-screen";

/**
 * "Mark all read": at the end of the rail's needs-you strip, and on the phone in
 * the sheet behind the strip's label. Its undo comes back to the strip's end on both.
 */

function agent(id: string, status: DashboardAgentCard["status"]): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status,
    workspaceId: "alpha", workspaceLabel: "alpha", workspaceCwd: "/work/alpha", cwd: "/work/alpha", tabId: "alpha:tab",
  };
}

const noAttention: HerdPaint = { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] };

function model(agents: DashboardAgentCard[]): HerdViewModel {
  return buildHerdViewModel({
    agents, listGroup: "flat", paneTouched: {}, paneActivated: {}, panePinned: {}, groupCollapsed: {},
    selectedPaneId: "", attention: noAttention, liveness: "live", status: { tone: "live", text: "已连接" },
    reading: false, snapshotLoaded: true, recentDirs: [], connected: true, networkOnline: true, runtimeKind: "herdr",
    createConversation: true, operationBusy: false, morphingPaneId: null,
    host: { name: "studio", line: "已连接", tone: "live" }, createTab: true, now: 10 * 60_000,
  });
}

let calls: string[] = [];
let opened: string[] = [];
let receipt: ReadAllReceipt | null = null;

const noop = () => {};
const actions = {
  openPaneFromCard: noop, openPaneMenu: noop, openWorkspaceMenu: noop, toggleGroup: noop, createConversation: noop,
  openDesktop: noop, openBoard: noop, openSettings: noop, openComputers: noop, runEmptyAction: noop, createInDir: noop, openHostMenu: noop,
  openGroupModeMenu: noop, openAttention: (paneId: string) => { opened.push(paneId); }, revealAttention: noop, createInWorkspace: noop, openCreate: noop,
  openQuickCreate: noop, togglePin: noop, markRead: noop,
  markAllRead: () => {
    calls.push("readAll");
    return receipt;
  },
} satisfies HerdActions;

function paint(agents: DashboardAgentCard[], variant: "page" | "rail" = "rail"): void {
  act(() => renderReact(<HerdScreen view={model(agents)} actions={actions} variant={variant} />));
}

const button = () => appRoot().querySelector<HTMLButtonElement>(".attn-read-all");
const press = () => act(() => button()!.click());
const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet");
const label = () => appRoot().querySelector<HTMLButtonElement>(".attn-strip-label.is-more");
const rows = () => [...sheet()!.querySelectorAll<HTMLButtonElement>(".menu-choice")];

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  calls = [];
  opened = [];
  receipt = { count: 2, undo: () => calls.push("undo") };
});

afterEach(async () => {
  jest.useRealTimers();
  await act(async () => { closeTestDialogs(); await pause(); });
  act(() => unmountReact());
});

describe("mark all read on the rail", () => {
  test("is offered at the strip's end only while a completion is unread, and counts only those", () => {
    paint([agent("p1", "blocked"), agent("p2", "working")]);
    expect(appRoot().querySelector(".attn-strip")).not.toBeNull();
    expect(button()).toBeNull();

    paint([agent("p1", "blocked"), agent("p2", "done"), agent("p3", "done")]);
    const action = button()!;
    expect(action.getAttribute("aria-label")).toBe("将 2 个已完成的会话标为已读");
    expect(action.textContent).toBe("全部已读");
    // Beside the scrolling tickets, not one of them.
    expect(action.parentElement?.classList.contains("attn-bar")).toBeTrue();
    expect(appRoot().querySelector(".attn-strip")!.contains(action)).toBeFalse();
  });

  test("a press reads them all and turns the same button into an undo while blocked rows stay", () => {
    paint([agent("p1", "blocked"), agent("p2", "done"), agent("p3", "done")]);
    const action = button()!;
    action.focus();
    press();
    expect(calls).toEqual(["readAll"]);
    // The list answers with the reads applied.
    paint([agent("p1", "blocked"), agent("p2", "idle"), agent("p3", "idle")]);
    expectSameNode(button(), action);
    expectSameNode(document.activeElement, action);
    expect(action.classList.contains("is-undo")).toBeTrue();
    expect(action.textContent).toBe("撤销");
    expect(action.getAttribute("aria-label")).toBe("撤销，2 个会话恢复未读");
    expect(appRoot().querySelectorAll(".attn-ticket:not(.is-leaving)").length).toBe(1);
    expect(appRoot().querySelector("[role=status].sr-only")?.textContent).toBe("已将 2 个会话标为已读");

    press();
    expect(calls).toEqual(["readAll", "undo"]);
    paint([agent("p1", "blocked"), agent("p2", "done"), agent("p3", "done")]);
    expect(button()!.textContent).toBe("全部已读");
  });

  test("with nothing left the strip stays to say what was done, then goes when the undo lapses", () => {
    jest.useFakeTimers();
    paint([agent("p2", "done")]);
    press();
    paint([agent("p2", "idle")]);
    expect(appRoot().querySelector(".attn-strip-note")?.textContent).toBe("已将 2 个会话标为已读");
    expect(button()!.textContent).toBe("撤销");

    act(() => jest.advanceTimersByTime(5000));
    // Shutting, it still ends as it was drawn: no "needs you 0", no empty end.
    expect(appRoot().querySelector(".attn-strip-label")).toBeNull();
    act(() => jest.advanceTimersByTime(5000));
    expect(appRoot().querySelector(".attn-strip")).toBeNull();
    expect(calls).toEqual(["readAll"]);
  });

  test("nothing to read makes no undo", () => {
    receipt = null;
    paint([agent("p2", "done")]);
    press();
    expect(button()!.textContent).toBe("全部已读");
  });

  test("its name is a tooltip beside the icon", () => {
    paint([agent("p1", "done")], "rail");
    const action = button()!;
    expect(action.getAttribute("title")).toBe("全部已读");
    expect(action.getAttribute("aria-label")).toBe("将 1 个已完成的会话标为已读");
    press();
    expect(calls).toEqual(["readAll"]);
  });
});

describe("the phone strip's label", () => {
  test("opens every waiting session instead of holding an action at the strip's end", () => {
    paint([agent("p1", "blocked"), agent("p2", "done"), agent("p3", "done")], "page");
    expect(button()).toBeNull();
    const more = label()!;
    expect(more.getAttribute("aria-label")).toBe("查看全部 3 个需要你的会话");
    expect(more.getAttribute("aria-haspopup")).toBe("dialog");
    act(() => more.click());
    expect(sheet()?.open).toBeTrue();
    expect(sheet()!.querySelector("h2")?.textContent).toBe("需要你");
    // The strip's order, each with its status, then the action naming what it leaves alone.
    expect(rows().map(row => row.querySelector(".menu-choice-title")?.textContent)).toEqual(["p1", "p2", "p3", "全部已读"]);
    expect(rows()[0].querySelector(".card-status")?.textContent).toBe("等你");
    expect(rows()[3].querySelector(".menu-choice-detail")?.textContent).toBe("将 2 个已完成的会话标为已读，等你的不变");
  });

  test("a row opens its session, as its ticket does", async () => {
    paint([agent("p1", "blocked"), agent("p2", "done")], "page");
    act(() => label()!.click());
    await act(async () => { rows()[1].click(); await pause(10); });
    expect(sheet()).toBeNull();
    expect(opened).toEqual(["p2"]);
    expect(calls).toEqual([]);
  });

  test("mark all read closes the sheet and leaves its undo at the strip's end", async () => {
    paint([agent("p1", "blocked"), agent("p2", "done"), agent("p3", "done")], "page");
    act(() => label()!.click());
    await act(async () => { rows().at(-1)!.click(); await pause(10); });
    expect(sheet()).toBeNull();
    expect(calls).toEqual(["readAll"]);
    paint([agent("p1", "blocked"), agent("p2", "idle"), agent("p3", "idle")], "page");
    expect(button()!.textContent).toBe("撤销");
    expect(appRoot().querySelector("[role=status].sr-only")?.textContent).toBe("已将 2 个会话标为已读");
    press();
    expect(calls).toEqual(["readAll", "undo"]);
    paint([agent("p1", "blocked"), agent("p2", "done"), agent("p3", "done")], "page");
    // Back to the label alone: the action lives in the sheet.
    expect(button()).toBeNull();
  });

  test("with only waiting sessions the sheet has nothing to mark", () => {
    paint([agent("p1", "blocked")], "page");
    act(() => label()!.click());
    expect(rows().map(row => row.querySelector(".menu-choice-title")?.textContent)).toEqual(["p1"]);
  });
});
