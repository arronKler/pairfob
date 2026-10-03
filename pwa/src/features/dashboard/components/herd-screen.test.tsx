import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { HerdPaint } from "../../../lib/herd-attention";
import { setLang, t } from "../../../lib/i18n";
import { PINNED_GROUP_ID } from "../../../lib/ranking";
import { appRoot } from "../../../app/dom-root";
import { clearNotice, showStatus } from "../../../app/notices-store";
import { setOperationBusy } from "../../operations/capabilities-store";
import { preferencesStore } from "../../settings/preferences-store";
import { selectPane } from "../../session/session-store";
import { replaceAgentsFromSnapshot } from "../catalog-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { setHerdSessionList } from "../../herd-sessions/store";
import type { LiveSession } from "../../../lib/protocol/session-types";
import { HerdSessionRow } from "../../herd-sessions/herd-session-row";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import type { HerdActions } from "../actions";

const app = appRoot;
import { buildHerdViewModel, type HerdModelInput, type HerdViewModel } from "../model/herd-view";
import { HerdScreen } from "./herd-screen";

function agent(id: string, workspace: string, status: DashboardAgentCard["status"] = "idle"): DashboardAgentCard {
  return {
    paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status,
    workspaceId: workspace, workspaceLabel: workspace, workspaceCwd: `/work/${workspace}`,
    cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab`,
  };
}

function terminal(id: string, workspace: string): DashboardAgentCard {
  return { ...agent(id, workspace), agent: "", hasAgent: false };
}

const noAttention: HerdPaint = { stagger: false, markOf: () => "", isDismissing: () => false, completed: [] };

function model(overrides: Partial<HerdModelInput> = {}): HerdViewModel {
  return buildHerdViewModel({
    agents: [agent("p1", "alpha"), agent("p2", "beta", "working")],
    listGroup: "flat",
    paneTouched: {},
    paneActivated: {},
    panePinned: {},
    groupCollapsed: {},
    selectedPaneId: "p1",
    attention: noAttention,
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
    computerCount: 1,
    morphingPaneId: null,
    host: { name: "studio", line: "已连接 · P2P 直连 · 18 毫秒", tone: "live" },
    createTab: true,
    now: 10 * 60_000,
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
  createInDir: (dir) => calls.push(`createIn:${dir}`),
  openHostMenu: () => calls.push("host"),
  openGroupModeMenu: () => calls.push("groupMode"),
  openAttention: (paneId) => calls.push(`attention:${paneId}`),
  revealAttention: (groupId, kind) => calls.push(`reveal:${groupId}:${kind}`),
  createInWorkspace: (card) => calls.push(`createIn:${card?.workspaceId ?? "none"}`),
  openCreate: () => calls.push("openCreate"),
  openQuickCreate: () => calls.push("quickCreate"),
  togglePin: (paneId) => calls.push(`pin:${paneId}`),
  markRead: (paneId) => calls.push(`read:${paneId}`),
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

function click(selector: string): void {
  act(() => app().querySelector<HTMLButtonElement>(selector)!.click());
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  calls = [];
  clearNotice();
});

afterEach(() => {
  act(() => unmountReact());
  attachLiveSession(null);
  clearNotice();
});

describe("herd screen presentation", () => {
  test("the screen renders the model it was handed, not the live record", () => {
    const view = model();
    // The live domains move on before React runs: empty herd, busy, a different
    // selection. The screen must still render exactly the props it was handed.
    act(() => {
      replaceAgentsFromSnapshot({ panes: [] });
      setOperationBusy(true);
      selectPane("other");
    });
    paint(view);
    expect([...app().querySelectorAll(".card-name")].map((node) => node.textContent)).toEqual(["p1", "p2"]);
    expect(app().querySelectorAll(".card.sel")).toHaveLength(1);
    expect(app().querySelector(".card.status-working")).not.toBeNull();
    expect(app().querySelector<HTMLButtonElement>(".create-fab")?.disabled).toBe(false);
  });

  test("the phone page is the option B header, notices, the list and the create button", () => {
    act(() => showStatus("notice above cards", true));
    paint(model(), "page");
    const page = app().querySelector(".page.herd-page")!;
    const children = [...page.children];
    const headAt = children.findIndex((node) => node.matches(".herd-head"));
    const noticeAt = children.findIndex((node) => node.matches("[data-react-notice]"));
    const listAt = children.findIndex((node) => node.matches(".herd-list"));
    expect(headAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(headAt);
    expect(listAt).toBeGreaterThan(noticeAt);
    expect(children[noticeAt].textContent).toBe("notice above cards");
    // No old top bar or status line on the phone: the computer is the title.
    expect(page.querySelector(".topbar, .statusline")).toBeNull();
    expect(page.querySelector(".host-title-name")?.textContent).toBe("studio");
    expect(page.querySelector(".host-title-line")?.textContent).toBe("已连接 · P2P 直连 · 18 毫秒");
    expect(page.querySelector(".herd-mode")?.textContent).toBe(t("list.modeFlat"));
    paint(model(), "rail");
    expect(app().firstElementChild?.className).toBe("rail");
    expect(app().querySelector(".rail [data-react-notice]")).toBeNull();
    expect(app().querySelector(".rail .herd-list")).not.toBeNull();
    expect(app().querySelector(".rail .topbar")).not.toBeNull();
    expect(app().querySelector(".rail .create-fab")).toBeNull();
  });

  test("header controls fire one narrow action each: computer panel, grouping, create and quick create", () => {
    paint(model());
    click(".host-title");
    click(".herd-mode");
    click(".create-fab");
    hold(app().querySelector<HTMLElement>(".create-fab")!);
    expect(calls).toEqual(["host", "groupMode", "openCreate", "quickCreate"]);
    calls = [];
    paint(model({ createConversation: false }));
    expect(app().querySelector(".create-fab")).toBeNull();
  });

  test("a card click opens its pane with the title element, a hold asks for the pane menu", () => {
    paint(model());
    act(() => cardMain("p1").click());
    expect(calls).toEqual(["openPane:p1:card-title"]);
    calls = [];
    hold(cardMain("p2"));
    expect(calls).toEqual(["paneMenu:p2"]);
  });

  test("an agent row names its status; a terminal row names none and shows its shell mark", () => {
    paint(model({ agents: [agent("run", "alpha", "working"), terminal("build log", "alpha")], paneTouched: { run: 3 * 60_000 } }));
    const run = cardMain("run").closest(".card")!;
    const zsh = cardMain("build log").closest(".card")!;
    expect(run.querySelector(".card-status")?.textContent).toBe(t("status.working"));
    expect(run.querySelector(".agent-avatar.is-mark")).not.toBeNull();
    expect(run.querySelector(".card-ago")?.textContent).toBe(t("list.agoMin", { n: "7" }));
    expect(zsh.classList.contains("is-terminal")).toBe(true);
    expect(zsh.querySelector(".card-status")).toBeNull();
    expect(zsh.querySelector(".agent-avatar.is-terminal")).not.toBeNull();
    expect(zsh.querySelector(".agent-avatar-status")).toBeNull();
  });

  test("grouped mode toggles, names the workspace root and exposes + and the menu", () => {
    paint(model({
      listGroup: "space",
      agents: [agent("p1", "alpha"), agent("p2", "beta")],
      panePinned: { p2: 4 },
      groupCollapsed: {},
    }));
    const headings = [...app().querySelectorAll<HTMLButtonElement>(".group-title")];
    expect(headings.map((node) => node.getAttribute("aria-haspopup"))).toEqual([null, "menu"]);
    expect(headings.map((node) => node.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect([...app().querySelectorAll(".group-path")].map((node) => node.textContent)).toEqual(["/work/alpha"]);
    act(() => headings[1].click());
    // The fold carries the order this list was rendered from, not the record's.
    expect(calls).toEqual([`toggle:alpha:${PINNED_GROUP_ID},alpha`]);
    calls = [];
    hold(headings[0]);
    expect(calls).toEqual([]);
    hold(headings[1]);
    const tools = [...app().querySelectorAll<HTMLButtonElement>(".group-tool")];
    expect(tools).toHaveLength(2);
    act(() => tools[0].click());
    act(() => tools[1].click());
    expect(calls).toEqual(["workspaceMenu:p1", "createIn:alpha", "workspaceMenu:p1"]);
  });

  test("a workspace without create_tab offers no + on its heading", () => {
    paint(model({ listGroup: "space", agents: [agent("p1", "alpha")], createTab: false }));
    expect(app().querySelectorAll(".group-tool")).toHaveLength(1);
  });

  test("flat mode keeps bare section titles and the stagger indices", () => {
    paint(model({ attention: { ...noAttention, stagger: true } }));
    expect(app().querySelector(".herd-list")?.className).toBe("herd-list enter");
    expect(app().querySelector(".group-title")).toBeNull();
    expect([...app().querySelectorAll<HTMLElement>(".section-title, .card")].map((node) => node.style.getPropertyValue("--i")))
      .toEqual(["0", "1", "2"]);
  });

  test("the empty state runs the action kind the model chose", () => {
    // Nothing open: one create action, recent folders, and no floating button or grouping.
    paint(model({ agents: [], recentDirs: ["~/work/pairfob", "~/work/site"] }));
    expect(app().querySelector(".herd-empty-title")?.textContent).toBe(t("empty.hostTitle", { host: "studio" }));
    expect(app().querySelector(".create-fab")).toBeNull();
    expect(app().querySelector(".herd-mode")).toBeNull();
    act(() => app().querySelector<HTMLButtonElement>(".herd-empty-action")!.click());
    act(() => [...app().querySelectorAll<HTMLButtonElement>(".herd-empty-dir")][1].click());
    expect(calls).toEqual(["empty:create", "createIn:~/work/site"]);
    calls = [];
    // Herdr gone: a solid panel with the command to run and a retry.
    paint(model({ agents: [], liveness: "exited", runtimeKind: "offline" }));
    expect(app().querySelector(".herd-empty-panel.is-exited code")?.textContent).toBe("pairfob doctor");
    act(() => app().querySelector<HTMLButtonElement>(".herd-empty-action")!.click());
    expect(calls).toEqual(["empty:retry"]);
    // Offline: the header says so; the list only notes what happens next, no button.
    paint(model({ agents: [], connected: false, networkOnline: false, liveness: "unverifiable" }));
    expect(app().querySelector(".herd-empty-note")?.textContent).toBe(t("empty.offlineNote", { host: "studio" }));
    expect(app().querySelector(".herd-empty-action")).toBeNull();
    expect(app().querySelector(".herd-skeleton.is-still")).not.toBeNull();
  });

  test("the desktop rail top bar fires one narrow action per control and follows the model gates", () => {
    paint(model({ computerCount: 2 }), "rail");
    act(() => app().querySelector<HTMLButtonElement>(".topbar-create")!.click());
    const links = () => [...app().querySelectorAll<HTMLButtonElement>(".rail-nav .text-link")];
    act(() => links()[0].click());
    act(() => links()[1].click());
    act(() => links()[2].click());
    expect(calls).toEqual(["create", "computers", "board", "settings"]);
    calls = [];
    paint(model({ createConversation: false, computerCount: 1, operationBusy: true }), "rail");
    expect(app().querySelector(".topbar-create")).toBeNull();
    expect([...app().querySelectorAll(".rail-nav button")]).toHaveLength(2);
  });

  test("the needs-you strip lists waiting rows first and opens a pane directly", () => {
    paint(model({ agents: [agent("done", "alpha", "done"), agent("wait", "beta", "blocked"), terminal("sh", "beta")] }));
    const tickets = [...app().querySelectorAll<HTMLButtonElement>(".attn-ticket")];
    expect(tickets.map((node) => node.querySelector(".attn-ticket-name")?.textContent)).toEqual(["wait", "done"]);
    expect(tickets.map((node) => node.className)).toEqual(["attn-ticket is-blocked", "attn-ticket is-done"]);
    expect(app().querySelector(".attn-strip-label")?.firstChild?.textContent).toBe(t("list.needsYouTitle"));
    expect(app().querySelector(".attn-count")?.textContent).toBe("2");
    // Unfolded, the strip is the shortcut; the header's copy of it stays out of reach.
    const pill = app().querySelector<HTMLButtonElement>(".herd-attn-pill")!;
    expect(pill.tabIndex).toBe(-1);
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(app().querySelector(".attn-wrap")?.hasAttribute("inert")).toBe(false);
    act(() => tickets[0].click());
    expect(calls).toEqual(["attention:wait"]);
    // Nothing waiting, no strip.
    paint(model());
    expect(app().querySelector(".attn-strip")).toBeNull();
  });

  test("scrolling folds the header: the strip steps back and the pill takes its place", async () => {
    paint(model({ agents: [agent("wait", "alpha", "blocked")] }));
    const scrollTo = async (y: number) => {
      Object.defineProperty(window, "scrollY", { configurable: true, value: y });
      await act(async () => {
        window.dispatchEvent(new happy.Event("scroll") as unknown as Event);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    };
    await scrollTo(60);
    // Below the fold threshold nothing changes, so a small nudge never flickers.
    expect(app().querySelector(".herd-head")?.classList.contains("is-folded")).toBe(false);
    await scrollTo(200);
    expect(app().querySelector(".herd-head")?.classList.contains("is-folded")).toBe(true);
    expect(app().querySelector(".attn-wrap")?.hasAttribute("inert")).toBe(true);
    const pill = app().querySelector<HTMLButtonElement>(".herd-attn-pill")!;
    expect(pill.tabIndex).toBe(0);
    expect(pill.hasAttribute("aria-hidden")).toBe(false);
    // Folded stays folded until the page is back near the top.
    await scrollTo(60);
    expect(app().querySelector(".herd-head")?.classList.contains("is-folded")).toBe(true);
    await scrollTo(0);
    expect(app().querySelector(".herd-head")?.classList.contains("is-folded")).toBe(false);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  test("a folded heading still reports what waits inside and jumps to it", () => {
    const agents = [agent("wait", "alpha", "blocked"), agent("done", "beta", "done")];
    const input = { agents, listGroup: "space" as const, groupCollapsed: { alpha: true, beta: true } };
    paint(model(input));
    expect([...app().querySelectorAll(".group-mark")].map((node) => node.textContent))
      .toEqual([t("list.markBlocked", { count: "1" }), t("list.markDone", { count: "1" })]);
    click(".group-mark.is-blocked");
    expect(preferencesStore.get().listGroupCollapsed.alpha).toBe(false);
    paint(model({ ...input, groupCollapsed: { alpha: false, beta: true } }));
    expect((document.activeElement as HTMLElement).dataset.paneId).toBe("wait");
    expect([...app().querySelectorAll(".group-title")].map(node => node.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  });

  test("rail attention shortcuts cycle independently without opening or filtering cards", () => {
    paint(model({ agents: [agent("a", "alpha", "blocked"), agent("b", "alpha", "blocked"),
      agent("c", "alpha", "done"), agent("d", "alpha", "done")] }), "rail");
    const focused = () => (document.activeElement as HTMLElement).dataset.paneId;
    click(".pending-count"); expect(focused()).toBe("a");
    click(".done-count"); expect(focused()).toBe("c");
    click(".pending-count"); expect(focused()).toBe("b");
    click(".pending-count"); expect(focused()).toBe("a");
    click(".done-count"); expect(focused()).toBe("d");
    expect(calls).toEqual([]);
    expect(app().querySelectorAll(".card-main")).toHaveLength(4);
  });

  test("stale sessions do not present attention as current", () => {
    paint(model({ agents: [agent("wait", "alpha", "blocked"), agent("done", "beta", "done")], liveness: "unverifiable" }));
    expect(app().querySelector(".attn-strip")).toBeNull();
    expect(app().querySelector(".group-mark")).toBeNull();
    expect(app().querySelector(".card.is-blocked, .card.is-unread")).toBeNull();
    expect(app().querySelectorAll(".card.unverifiable")).toHaveLength(2);
    expect([...app().querySelectorAll(".card-status")].map((node) => node.textContent))
      .toEqual([t("status.unverifiable"), t("status.unverifiable")]);
  });

  test("swipe actions run pin, menu and read through the same narrow actions", () => {
    paint(model({ agents: [agent("done", "alpha", "done"), agent("run", "alpha", "working")], panePinned: { run: 1 } }));
    const done = cardMain("done").closest(".card")!;
    act(() => done.querySelector<HTMLButtonElement>(".card-action.is-read")!.click());
    act(() => done.querySelector<HTMLButtonElement>(".card-action.is-pin")!.click());
    act(() => done.querySelector<HTMLButtonElement>(".card-action.is-more")!.click());
    const run = cardMain("run").closest(".card")!;
    expect(run.querySelector(".card-action.is-read")).toBeNull();
    expect(run.querySelector(".card-action.is-pin")?.textContent).toBe(t("list.swipeUnpin"));
    expect(calls).toEqual(["read:done", "pin:done", "paneMenu:done"]);
  });

  test("grouped results still honor collapse and expand actions", () => {
    const checking = { ...agent("check", "alpha", "idle"), interactiveReady: false };
    const input = { listGroup: "space" as const, agents: [checking], groupCollapsed: {} };
    paint(model(input));
    const heading = app().querySelector<HTMLButtonElement>(".group-title")!;
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    act(() => heading.click());
    expect(calls).toEqual(["toggle:alpha:alpha"]);
    calls = [];
    paint(model({ ...input, groupCollapsed: { alpha: true } }));
    expect(app().querySelector<HTMLButtonElement>(".group-title")?.getAttribute("aria-expanded")).toBe("false");
    act(() => app().querySelector<HTMLButtonElement>(".group-title")!.click());
    expect(calls).toEqual(["toggle:alpha:alpha"]);
  });

  test("the rail status line keeps its tone, text and completion count", () => {
    paint(model({ agents: [agent("p1", "alpha", "done"), agent("p2", "beta", "done")], status: { tone: "warn", text: t("chrome.unverifiable") } }), "rail");
    expect(app().querySelector(".statusline .dot-warn")).not.toBeNull();
    expect(app().querySelector(".statusline-text")?.textContent).toBe(t("chrome.unverifiable"));
    expect(app().querySelector(".done-count")?.textContent).toBe(t("home.doneCount", { count: "2" }));
    paint(model({ agents: [agent("p1", "alpha", "idle")] }), "rail");
    expect(app().querySelector(".done-count")).toBeNull();
  });
});

describe("the Herdr-session switch on the Sessions tab", () => {
  // The switch reads the live connection, not the view model, so the fixture is
  // a connection that names its selection plus the list a daemon would return.
  function liveWithSessions(selected: string | null): void {
    const live = { herdSession: () => selected } as unknown as LiveSession;
    attachLiveSession(live);
    setHerdSessionList(live, [{ name: null, running: true }, { name: "personal", running: true }]);
  }
  const switchText = () => app().querySelector(".herd-session-switch")?.textContent ?? null;

  test("the phone header and the desktop rail both carry it, naming the selection", () => {
    liveWithSessions("personal");
    paint(model());
    expect(app().querySelector(".herd-head .herd-session-switch")).not.toBeNull();
    expect(switchText()).toBe("personal");
    paint(model(), "rail");
    expect(app().querySelector(".rail-nav .herd-session-switch")).not.toBeNull();
  });

  test("phone, rail and Settings share the running-or-selected visibility rule", () => {
    for (const scenario of [
    { name: "default only", current: null, named: false, running: false, visible: false },
    { name: "a stopped named server", current: null, named: true, running: false, visible: false },
    { name: "a running named server", current: null, named: true, running: true, visible: true },
    { name: "the selected named server has stopped", current: "personal", named: true, running: false, visible: true },
    ]) {
      const live = { herdSession: () => scenario.current } as unknown as LiveSession;
      act(() => {
        attachLiveSession(live);
        setHerdSessionList(live, [
          { name: null, running: true },
          ...(scenario.named ? [{ name: "personal", running: scenario.running }] : []),
        ]);
      });
      paint(model());
      expect(app().querySelector(".herd-session-switch") !== null).toBe(scenario.visible);
      paint(model(), "rail");
      expect(app().querySelector(".herd-session-switch") !== null).toBe(scenario.visible);
      act(() => renderReact(<HerdSessionRow />));
      expect(app().querySelector("button") !== null).toBe(scenario.visible);
    }
  });
});
