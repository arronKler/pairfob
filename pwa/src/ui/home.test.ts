import { closeTestDialogs } from "../../test-support/close-dialogs";
import { resetBoardTestDOM } from "../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { LiveSession } from "../lib/protocol/session-types";
import type { DashboardAgentCard } from "../lib/dashboard";
import { resetHerdAttention } from "../lib/herd-attention";
import { setLang, t } from "../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../lib/operations";
import { PINNED_GROUP_ID } from "../lib/ranking";
import { app, clearNotice, showStatus, state } from "../state";
import { setRenderer } from "../paint";
import { renderHome } from "./home";
import { leaveReactScreen } from "./react/root";

const liveSource = await Bun.file(new URL("../live-operations.ts", import.meta.url)).text();
let connected = true;
function agent(id: string, workspace: string): DashboardAgentCard {
  return { paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status: "idle",
    workspaceId: workspace, workspaceLabel: workspace, cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab` };
}
function paint(): void { act(renderHome); }

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  connected = true;
  Object.assign(state, { phase: "live", screen: "home", credential: null, paneId: "", computers: [],
    agents: [agent("p1", "alpha"), agent("p2", "beta"), agent("p3", "gamma")], agentKinds: [],
    paneTouched: {}, panePinned: {}, listGroup: "flat", listGroupCollapsed: {},
    operationBusy: false, runtimeKind: "herdr", networkOnline: true, herdHost: "" });
  state.live = { isConnected: () => connected } as LiveSession;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES, create_conversation: true };
  resetHerdAttention();
  clearNotice();
  setLang("zh");
  setRenderer(renderHome);
});

afterEach(async () => {
  await act(async () => {
    closeTestDialogs();
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    leaveReactScreen();
  });
  setRenderer(() => {});
  clearNotice();
  resetHerdAttention();
  state.live = null;
  state.phase = "boot";
});

describe("home new session", () => {
  test("create conversation is not gated on advertised agent kinds", () => {
    paint();
    const create = () => app.querySelector<HTMLButtonElement>(".topbar-create")!;
    expect(create().disabled).toBe(false);
    expect(create().textContent).toBe(t("home.new"));
    act(() => create().click());
    expect(document.querySelector("dialog .modal-title")?.textContent).toBe(t("form.newConversation"));
    expect(document.querySelector<HTMLInputElement>('dialog [name="cwd"]')?.value).toBe("/tmp/alpha");
    expect([...document.querySelectorAll('dialog [name="agent_kind"] option')].map(option => option.textContent))
      .toEqual([t("form.plainTerminal")]);
    act(closeTestDialogs);
    expect(app.textContent).not.toContain("电脑没有提供可用的 Agent 类型");
    expect(app.querySelector(".home-create") === null).toBe(true);
    expect(app.textContent).not.toContain("＋ 新建会话");
    state.operationBusy = true;
    paint();
    expect(create().disabled).toBe(true);
    expect(create().textContent).toBe(t("home.creating"));
    state.operationBusy = false;
    connected = false;
    paint();
    expect(create().disabled).toBe(true);
    expect(liveSource).toContain("askCreateConversation(state.agentKinds, defaults)");
    expect(liveSource).not.toContain("!state.agentKinds.length");
  });
});

describe("home chrome", () => {
  test("the session list does not carry a product-feedback link", () => {
    paint();
    expect(app.textContent).not.toContain("遇到问题");
    expect(app.querySelector('a[href*="issues/new"]') === null).toBe(true);
    expect(app.querySelector(".homeFeedback") === null).toBe(true);
  });

  test("app notices sit above the session cards", () => {
    act(() => showStatus("notice above cards", true));
    paint();
    const page = app.querySelector(".page")!;
    const children = [...page.children];
    const noticeAt = children.findIndex(node => node.matches("[data-react-notice]"));
    const listAt = children.findIndex(node => node.matches(".herd-list"));
    expect(noticeAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(noticeAt);
  });
});

describe("home pinned sessions", () => {
  test("cards mark pinned panes and pass pins into grouping", () => {
    state.listGroup = "space";
    state.panePinned = { p3: 1 };
    paint();
    expect([...app.querySelectorAll(".group-name")].map(node => node.textContent)).toEqual([t("group.pinned"), "alpha", "beta"]);
    expect(app.querySelector(".card.pinned .card-name")?.textContent).toBe("p3");
    expect(app.querySelector(".pin-mark")?.getAttribute("aria-hidden")).toBe("true");
    expect(app.querySelector(".card.pinned .sr-only")?.textContent).toBe(t("home.pinned"));
    expect(state.listGroupCollapsed[PINNED_GROUP_ID]).toBe(false);
    expect((app.querySelector(".group-title")?.getAttribute("aria-haspopup")) === null).toBe(true);
    expect(app.querySelectorAll(".group-title")[1].getAttribute("aria-haspopup")).toBe("menu");
  });
});

describe("home grouped list", () => {
  test("grouped headings toggle and start with later groups collapsed", () => {
    state.listGroup = "space";
    paint();
    const headings = [...app.querySelectorAll<HTMLButtonElement>(".group-title")];
    expect(headings.map(node => node.getAttribute("aria-expanded"))).toEqual(["true", "false", "false"]);
    expect([...app.querySelectorAll<HTMLElement>(".herd-group-body")].map(node => node.hidden)).toEqual([false, true, true]);
    act(() => headings[1].click());
    expect(state.listGroupCollapsed.beta).toBe(false);
    expect((app.querySelectorAll(".herd-group-body")[1] as HTMLElement).hidden).toBe(false);
    paint();
    expect(app.querySelectorAll(".group-title")[1].getAttribute("aria-expanded")).toBe("true");
    expect(app.querySelector(".section-title") === null).toBe(true);
  });
});
