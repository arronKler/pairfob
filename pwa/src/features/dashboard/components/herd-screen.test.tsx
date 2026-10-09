import { expectSameNode } from "../../../../test-support/node-identity";
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
import { bindOverlayOrigin, overlayOrigin } from "../../../shared/ui/overlay/origin";
import type { HerdActions } from "../actions";
import { workspaceMenuModel } from "../model/object-menu";

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
    expect(app().querySelector(".rail .create-fab")).toBeNull();
  });

  test("the desktop rail is a fixed head, search and foot around the one region that scrolls", () => {
    paint(model({ agents: [agent("wait", "alpha", "blocked"), agent("p2", "beta")] }), "rail");
    expect([...app().querySelector(".rail")!.children].map((node) => node.className))
      .toEqual(["rail-head", "rail-search", "attn-wrap", "rail-list", "rail-nav"]);
    // The list, and only the list, sits in the scrolling region.
    expect(app().querySelector(".rail-list > .herd-list")).not.toBeNull();
    expect(app().querySelectorAll(".rail .herd-list")).toHaveLength(1);
    // The head is the phone header's parts; the old brand, link row, status line
    // and segmented grouping are gone.
    expect(app().querySelector(".rail-head h1")?.textContent).toBe(t("tabs.sessions"));
    expect(app().querySelector(".rail-head .host-title-name")?.textContent).toBe("studio");
    expect(app().querySelector(".rail-head .host-title-line")?.textContent).toBe("已连接 · P2P 直连 · 18 毫秒");
    expect(app().querySelector(".rail-head .herd-mode")?.getAttribute("aria-label"))
      .toBe(t("list.modeAria", { mode: t("list.modeFlat") }));
    expect(app().querySelector(".rail :is(.topbar, .wordmark, .statusline, .seg, .text-link)")).toBeNull();
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

  test("the desktop rail controls fire one narrow action each and follow the model gates", () => {
    paint(model(), "rail");
    click(".rail-head .host-title");
    click(".rail-head .herd-mode");
    click(".rail-create");
    hold(app().querySelector<HTMLElement>(".rail-create")!);
    const destinations = () => [...app().querySelectorAll<HTMLButtonElement>(".rail-nav button")];
    act(() => destinations()[0].click());
    act(() => destinations()[1].click());
    expect(calls).toEqual(["host", "groupMode", "create", "quickCreate", "board", "settings"]);
    expect(destinations().map((node) => node.textContent)).toEqual([t("home.board"), t("home.settings")]);
    calls = [];
    // No capability, no create; an empty list has nothing to group.
    paint(model({ createConversation: false, agents: [] }), "rail");
    expect(app().querySelector(".rail-create")).toBeNull();
    expect(app().querySelector(".rail-head .herd-mode")).toBeNull();
    expect(destinations()).toHaveLength(2);
    paint(model({ operationBusy: true }), "rail");
    expect(app().querySelector<HTMLButtonElement>(".rail-create")?.disabled).toBe(true);
  });

  test("the rail marks the board as current only while it is the page beside it", () => {
    paint(model({ boardOpen: true }), "rail");
    const current = app().querySelector(".rail-nav .is-current");
    expect(current?.textContent).toBe(t("home.board"));
    expect(current?.getAttribute("aria-current")).toBe("page");
    paint(model(), "rail");
    expect(app().querySelector(".rail-nav [aria-current]")).toBeNull();
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

  test("the rail strip opens a pane from a ticket and its label walks the list without opening or filtering", () => {
    paint(model({ agents: [agent("a", "alpha", "blocked"), agent("c", "alpha", "done"),
      agent("b", "alpha", "blocked"), agent("d", "alpha", "done")], paneTouched: { a: 4, b: 3, c: 2, d: 1 } }), "rail");
    const label = app().querySelector<HTMLButtonElement>(".rail .attn-strip-label")!;
    expect(label.tagName).toBe("BUTTON");
    expect(label.getAttribute("aria-label")).toBe(t("rail.nextAttention", { count: "4" }));
    const focused = () => (document.activeElement as HTMLElement).dataset.paneId;
    // The strip's order: rows waiting on the reader, then unread completions, then around again.
    const walked: Array<string | undefined> = [];
    for (let step = 0; step < 5; step++) {
      act(() => label.click());
      walked.push(focused());
    }
    expect(walked).toEqual(["a", "b", "c", "d", "a"]);
    expect(calls).toEqual([]);
    expect(app().querySelectorAll(".card-main")).toHaveLength(4);
    act(() => app().querySelector<HTMLButtonElement>(".rail .attn-ticket")!.click());
    expect(calls).toEqual(["attention:a"]);
    // On the phone the label is plain text: the strip is one swipe wide there.
    paint(model({ agents: [agent("a", "alpha", "blocked")] }));
    expect(app().querySelector(".attn-strip-label")?.tagName).toBe("SPAN");
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

  test("the rail head carries the connection tone and line; a runtime that is off keeps its banner", () => {
    paint(model({ host: { name: "studio", line: t("host.unverifiedLine"), tone: "warn" },
      status: { tone: "warn", text: t("chrome.unverifiable") } }), "rail");
    expect(app().querySelector(".rail-head .host-title.is-warn .dot-warn")).not.toBeNull();
    expect(app().querySelector(".rail-head .host-title-line")?.textContent).toBe(t("host.unverifiedLine"));
    expect(app().querySelector(".rail > .banner")).toBeNull();
    paint(model({ status: { tone: "off", text: t("chrome.herdrOff") } }), "rail");
    expect(app().querySelector(".rail > .banner.banner-off")?.textContent).toBe(t("chrome.herdrOffBanner"));
    // With no rows the list names it itself, as the page does: once, not in a banner as well.
    paint(model({ agents: [], liveness: "exited", runtimeKind: "offline", status: { tone: "off", text: t("chrome.herdrOff") } }), "rail");
    expect(app().querySelector(".rail > .banner")).toBeNull();
    expect(app().querySelector(".rail-list .herd-empty.is-beside")?.textContent).toBe(t("empty.exitedTitle"));
    expect(app().querySelector<HTMLButtonElement>(".rail-create")?.disabled).toBe(true);
  });
});

describe("rail rows under a precise pointer", () => {
  const FINE_POINTER = "(hover: hover) and (pointer: fine)";
  const realMatchMedia = window.matchMedia;
  /** Answer the pointer query the way a mouse (or a finger) would. */
  function pointer(fine: boolean): void {
    window.matchMedia = ((query: string) => query === FINE_POINTER
      ? { matches: fine, media: query, addEventListener() {}, removeEventListener() {} }
      : realMatchMedia.call(window, query)) as typeof window.matchMedia;
  }
  afterEach(() => { window.matchMedia = realMatchMedia; });

  const agents = [agent("done", "alpha", "done"), agent("run", "alpha", "working")];
  const row = (name: string) => cardMain(name).closest(".card")!;
  const cluster = (name: string) => row(name).querySelector(".card-actions")!;
  /** A finger dragging the row sideways, far enough to open the trailing actions. */
  function swipeLeft(target: Element): void {
    const touch = (type: string, x: number) => target.dispatchEvent(new happy.PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 3, pointerType: "touch", clientX: x, clientY: 20,
    }) as unknown as Event);
    touch("pointerdown", 300);
    for (const x of [270, 240, 200, 160, 120]) touch("pointermove", x);
    touch("pointerup", 120);
  }

  test("the swipe's buttons follow the row as a named cluster a mouse and the keyboard both reach", () => {
    pointer(true);
    paint(model({ agents, panePinned: { run: 1 } }), "rail");
    // After the row's button in the document, where a screen reader meets them next.
    expectSameNode(cardMain("done").nextElementSibling, cluster("done"));
    expect(cluster("done").hasAttribute("aria-hidden")).toBe(false);
    const buttons = [...cluster("done").querySelectorAll<HTMLButtonElement>("button")];
    // Focusable, and not stops of their own: the list is one stop and Right goes into a row's actions (`list-keys`).
    expect(buttons.map((node) => [node.textContent, node.title, node.tabIndex])).toEqual([
      [t("list.swipeRead"), t("list.swipeRead"), -1],
      [t("list.swipePin"), t("list.swipePin"), -1],
      [t("list.swipeMore"), t("list.swipeMore"), -1],
    ]);
    expect(buttons[2].getAttribute("aria-haspopup")).toBe("menu");
    for (const button of buttons) act(() => button.click());
    expect(calls).toEqual(["read:done", "pin:done", "paneMenu:done"]);
    // Nothing to mark read on a row that is not an unread completion; a pinned row offers the way back.
    expect([...cluster("run").querySelectorAll("button")].map((node) => node.title))
      .toEqual([t("list.swipeUnpin"), t("list.swipeMore")]);
  });

  test("with the actions on hover, the row takes no swipe", () => {
    pointer(true);
    paint(model({ agents }), "rail");
    swipeLeft(cardMain("run"));
    expect(row("run").classList.contains("is-open")).toBe(false);
    expect(cardMain("run").style.transform).toBe("");
  });

  test("a touch rail and the phone page keep the buttons behind the swipe, out of reach until it opens", () => {
    for (const [fine, variant] of [[false, "rail"], [false, "page"], [true, "page"]] as const) {
      pointer(fine);
      paint(model({ agents }), variant);
      expect(cluster("done").getAttribute("aria-hidden")).toBe("true");
      expectSameNode(cluster("done").nextElementSibling, cardMain("done"));
      const buttons = [...cluster("done").querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons.map((node) => [node.tabIndex, node.hasAttribute("title")])).toEqual([[-1, false], [-1, false], [-1, false]]);
      swipeLeft(cardMain("run"));
      expect(row("run").classList.contains("is-open")).toBe(true);
      act(() => unmountReact());
    }
  });
});

describe("the rail's workspace headings and open rows", () => {
  const FINE_POINTER = "(hover: hover) and (pointer: fine)";
  const realMatchMedia = window.matchMedia;
  function pointer(fine: boolean): void {
    window.matchMedia = ((query: string) => query === FINE_POINTER
      ? { matches: fine, media: query, addEventListener() {}, removeEventListener() {} }
      : realMatchMedia.call(window, query)) as typeof window.matchMedia;
  }
  afterEach(() => { window.matchMedia = realMatchMedia; });

  const grouped = { listGroup: "space" as const, agents: [agent("wait", "alpha", "blocked"), agent("done", "alpha", "done")] };
  const tools = () => [...app().querySelectorAll<HTMLButtonElement>(".group-tool")].map((node) => node.getAttribute("aria-label"));

  test("under a finger the rail heading leaves create to its menu, so the name keeps the row", () => {
    pointer(false);
    paint(model(grouped), "rail");
    // Two marks and one tool: the workspace name is not squeezed to two letters.
    expect(app().querySelectorAll(".group-mark")).toHaveLength(2);
    expect(tools()).toEqual([t("list.workspaceMenu", { workspace: "alpha" })]);
    click(".group-tool");
    expect(calls).toEqual(["workspaceMenu:wait"]);
    // Nothing is out of reach: that menu opens with the same create.
    expect(workspaceMenuModel({ agent: agent("wait", "alpha"), createTab: true })?.items[0].kind).toBe("newTabInWorkspace");
  });

  test("a mouse rail, whose tools wait for hover, and the phone page keep the + on the heading", () => {
    for (const [fine, variant] of [[true, "rail"], [false, "page"], [true, "page"]] as const) {
      pointer(fine);
      paint(model(grouped), variant);
      expect(tools()).toEqual([t("list.newTabIn", { workspace: "alpha" }), t("list.workspaceMenu", { workspace: "alpha" })]);
      act(() => unmountReact());
    }
  });

  test("a right-click anywhere on a mouse rail's heading is the title's menu: at the pointer, and focus returns to the title", () => {
    const release = bindOverlayOrigin(document);
    pointer(true);
    paint(model(grouped), "rail");
    const mark = app().querySelector<HTMLButtonElement>(".group-mark")!;
    act(() => {
      mark.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 210, clientY: 60 }) as unknown as Event);
    });
    expect(calls).toEqual(["workspaceMenu:wait"]);
    expect(overlayOrigin()).toMatchObject({ target: app().querySelector(".group-title"), atPointer: true, x: 210, y: 60 });
    release();
  });

  /** A finger dragging the row sideways, far enough to open the trailing actions. */
  function swipeLeft(target: Element): void {
    const touch = (type: string, x: number) => target.dispatchEvent(new happy.PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 3, pointerType: "touch", clientX: x, clientY: 20,
    }) as unknown as Event);
    touch("pointerdown", 300);
    for (const x of [270, 240, 200, 160, 120]) touch("pointermove", x);
    touch("pointerup", 120);
  }

  test("a row left swiped open closes when the column beside the rail moves on by any road", () => {
    pointer(false);
    const agents = [agent("done", "alpha", "done"), agent("run", "alpha", "working")];
    const isOpen = () => cardMain("run").closest(".card")!.classList.contains("is-open");
    paint(model({ agents, selectedPaneId: "" }), "rail");
    swipeLeft(cardMain("run"));
    expect(isOpen()).toBe(true);
    // The list repainting under it (a status, the minute tick) is not a navigation.
    paint(model({ agents, selectedPaneId: "", now: 11 * 60_000 }), "rail");
    expect(isOpen()).toBe(true);
    // A session opened from a ticket, the empty column's card or search and jump.
    paint(model({ agents, selectedPaneId: "done" }), "rail");
    expect(isOpen()).toBe(false);
    expect(cardMain("run").style.transform).toBe("");
    swipeLeft(cardMain("run"));
    expect(isOpen()).toBe(true);
    paint(model({ agents, selectedPaneId: "done", boardOpen: true }), "rail");
    expect(isOpen()).toBe(false);
    swipeLeft(cardMain("run"));
    paint(model({ agents, selectedPaneId: "done", settingsOpen: true }), "rail");
    expect(isOpen()).toBe(false);
  });

  /** A finger landing on `target`, as the page sees it before anything else does. */
  function touchDown(target: Element): boolean {
    return target.dispatchEvent(new happy.PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 4, pointerType: "touch", clientX: 40, clientY: 20,
    }) as unknown as Event);
  }

  test("a press anywhere outside a row swiped open in the rail closes it, and still does what it was for", () => {
    pointer(false);
    const agents = [agent("done", "alpha", "done"), agent("run", "alpha", "working")];
    const openRow = () => cardMain("run").closest(".card")!;
    const isOpen = () => openRow().classList.contains("is-open");
    const beside = document.createElement("button");
    beside.className = "beside-the-rail";
    document.body.append(beside);
    let pressed = 0;
    beside.addEventListener("click", () => { pressed += 1; });
    paint(model({ agents, selectedPaneId: "done" }), "rail");

    // The session column, the inspector: anything that is not the rail at all.
    swipeLeft(cardMain("run"));
    expect(isOpen()).toBe(true);
    // Observed, never taken: the press is not cancelled and its click arrives.
    expect(touchDown(beside)).toBe(true);
    beside.click();
    expect(isOpen()).toBe(false);
    expect(cardMain("run").style.transform).toBe("");
    expect(pressed).toBe(1);

    // The rail's own chrome, and the row of the session that is already open.
    for (const selector of [".rail-search", ".group-title, .rail-head", ".rail-nav-item"]) {
      swipeLeft(cardMain("run"));
      expect(isOpen(), selector).toBe(true);
      touchDown(app().querySelector(selector)!);
      expect(isOpen(), selector).toBe(false);
    }
    swipeLeft(cardMain("run"));
    touchDown(cardMain("done"));
    click('.card-main[data-pane-id="done"]');
    expect(isOpen()).toBe(false);
    expect(calls).toContain("openPane:done:card-title");

    // Its own swipe and a tap on what it uncovered are the row's to settle.
    swipeLeft(cardMain("run"));
    touchDown(cardMain("run"));
    expect(isOpen()).toBe(true);
    const pin = openRow().querySelector<HTMLButtonElement>(".card-action.is-pin")!;
    touchDown(pin);
    expect(isOpen()).toBe(true);
    calls = [];
    act(() => pin.click());
    expect(calls).toEqual(["pin:run"]);
    expect(isOpen()).toBe(false);
    beside.remove();
  });

  test("the phone page keeps its rows: a press outside the list leaves one open", () => {
    pointer(false);
    const agents = [agent("done", "alpha", "done"), agent("run", "alpha", "working")];
    const isOpen = () => cardMain("run").closest(".card")!.classList.contains("is-open");
    paint(model({ agents, selectedPaneId: "" }), "page");
    swipeLeft(cardMain("run"));
    expect(isOpen()).toBe(true);
    touchDown(document.body);
    touchDown(app().querySelector(".herd-head")!);
    expect(isOpen()).toBe(true);
    // Another row is what closes it there, as before.
    touchDown(cardMain("done"));
    expect(isOpen()).toBe(false);
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
    // The rail's head keeps its width for the computer: the switch is the row
    // under it, and has the room to say what it switches and which is chosen.
    expect(app().querySelector(".rail-head .herd-session-switch")).toBeNull();
    const railSwitch = app().querySelector(".rail > .rail-head + .herd-session-switch");
    expect(railSwitch?.querySelector(".herd-session-kind")?.textContent).toBe(t("set.herdSession"));
    expect(railSwitch?.querySelector(".herd-session-name")?.textContent).toBe("personal");
    expect(railSwitch?.getAttribute("aria-label")).toBe(t("set.herdSessionAria", { name: "personal" }));
  });

  test("the rail's head draws the status as whole parts; the phone header keeps one sentence", () => {
    const host = { name: "MacBook Pro", line: "已连接 · P2P 直连 · 18 毫秒", tone: "live" as const, brief: ["P2P 直连", "18 毫秒"] };
    paint({ ...model(), host }, "rail");
    const title = app().querySelector<HTMLElement>(".rail-head .host-title")!;
    expect([...title.querySelectorAll(".host-title-line.is-brief .host-title-fact")].map(part => part.textContent)).toEqual(["P2P 直连", " · 18 毫秒"]);
    // What the row leaves out is still said: by the button's name, and to a resting pointer.
    expect(title.getAttribute("aria-label")).toBe(t("host.aria", { host: host.name, status: host.line }));
    expect(title.title).toBe(`${host.name} · ${host.line}`);
    // A status with no cut of its own is split where its sentence is joined.
    paint({ ...model(), host: { name: "MacBook Pro", line: "当前没有网络 · 联网后自动恢复", tone: "warn" as const } }, "rail");
    expect([...app().querySelectorAll(".rail-head .host-title-fact")].map(part => part.textContent)).toEqual(["当前没有网络", " · 联网后自动恢复"]);
    paint({ ...model(), host }, "page");
    const line = app().querySelector(".herd-head .host-title-line")!;
    expect(line.textContent).toBe(host.line);
    expect(line.children.length).toBe(0);
    expect(app().querySelector(".herd-head .host-title")!.hasAttribute("title")).toBe(false);
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
