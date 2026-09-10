import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { DashboardAgentCard } from "../../lib/dashboard";
import { resetHerdAttention } from "../../lib/herd-attention";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { PINNED_GROUP_ID } from "../../lib/ranking";
import { clearNotice, showStatus } from "../../app/notices-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { selectPane } from "../../features/session/session-store";
import {
  preferencesStore,
  resetHerdPresentationChoices,
  setListGroup,
  togglePanePin,
} from "../../features/settings/preferences-store";

// The herd/operation controller now owns the new-conversation flow; the form is
// offered with whatever the capabilities domain advertises (fail-closed), and an
// empty agent-kinds list still offers the plain terminal — never an early return.
const operationsSource = await Bun.file(new URL("../../features/operations/controller.ts", import.meta.url)).text();
let connected = true;
function agent(id: string, workspace: string): DashboardAgentCard {
  return { paneId: id, paneLabel: id, agent: "codex", hasAgent: true, status: "idle",
    workspaceId: workspace, workspaceLabel: workspace, cwd: `/tmp/${workspace}`, tabId: `${workspace}:tab` };
}

/** Seed the herd through the dashboard owner action. */
function seed(agents: DashboardAgentCard[]): void {
  const workspaces = [...new Set(agents.map((item) => item.workspaceId))]
    .map((workspace) => ({ workspace_id: workspace, label: workspace, cwd: `/tmp/${workspace}` }));
  const tabs = [...new Set(agents.map((item) => item.workspaceId))]
    .map((workspace) => ({ tab_id: `${workspace}:tab`, workspace_id: workspace, label: "main" }));
  const panes = agents.map((item) => ({
    pane_id: item.paneId,
    workspace_id: item.workspaceId,
    tab_id: item.tabId,
    cwd: item.cwd,
    agent: item.agent,
    agent_status: item.status,
    label: item.paneLabel,
  }));
  replaceAgentsFromSnapshot({ workspaces, tabs, panes });
}

/** The mounted App commit: prepares the frame (attention, shell) and renders once. */
function paint(): void {
  commitTest();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  connected = true;
  setLang("zh");
  setPhase("live");
  setScreen("home");
  // The new-conversation cwd follows the selected pane; each suite starts with no
  // open pane so the first agent's cwd is the default (resetBoardTestDOM does not
  // reset the session domain).
  selectPane("");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  setOperationBusy(false);
  setNetworkOnline(true);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, []);
  seed([agent("p1", "alpha"), agent("p2", "beta"), agent("p3", "gamma")]);
  attachLiveSession({ isConnected: () => connected } as unknown as LiveSession);
  resetHerdAttention();
  clearNotice();
  mountTestApp();
  paint();
});

afterEach(async () => {
  await act(async () => {
    closeTestDialogs();
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    unmountTestApp();
  });
  clearNotice();
  resetHerdAttention();
  attachLiveSession(null);
  setPhase("boot");
  resetDashboard();
  resetHerdPresentationChoices();
  appRoot().replaceChildren();
});

describe("home new session", () => {
  test("create conversation is not gated on advertised agent kinds", () => {
    const app = appRoot();
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
    act(() => setOperationBusy(true));
    paint();
    expect(create().disabled).toBe(true);
    expect(create().textContent).toBe(t("home.creating"));
    act(() => setOperationBusy(false));
    connected = false;
    paint();
    expect(create().disabled).toBe(true);
    expect(operationsSource).toContain("askCreateConversation([...advertisedAgentKinds()], defaults)");
    expect(operationsSource).not.toContain("!state.agentKinds.length");
  });
});

describe("home chrome", () => {
  test("the session list does not carry a product-feedback link", () => {
    const app = appRoot();
    expect(app.textContent).not.toContain("遇到问题");
    expect(app.querySelector('a[href*="issues/new"]') === null).toBe(true);
    expect(app.querySelector(".homeFeedback") === null).toBe(true);
  });

  test("app notices sit above the session cards", () => {
    const app = appRoot();
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
    const app = appRoot();
    act(() => {
      setListGroup("space");
      togglePanePin("p3");
    });
    paint();
    expect([...app.querySelectorAll(".group-name")].map(node => node.textContent)).toEqual([t("group.pinned"), "alpha", "beta"]);
    expect(app.querySelector(".card.pinned .card-name")?.textContent).toBe("p3");
    expect(app.querySelector(".pin-mark")?.getAttribute("aria-hidden")).toBe("true");
    expect(app.querySelector(".card.pinned .sr-only")?.textContent).toBe(t("home.pinned"));
    expect(preferencesStore.get().listGroupCollapsed[PINNED_GROUP_ID]).toBe(false);
    expect((app.querySelector(".group-title")?.getAttribute("aria-haspopup")) === null).toBe(true);
    expect(app.querySelectorAll(".group-title")[1].getAttribute("aria-haspopup")).toBe("menu");
  });
});

describe("home grouped list", () => {
  test("grouped headings toggle and start with later groups collapsed", () => {
    const app = appRoot();
    act(() => setListGroup("space"));
    paint();
    const headings = () => [...app.querySelectorAll<HTMLButtonElement>(".group-title")];
    expect(headings().map(node => node.getAttribute("aria-expanded"))).toEqual(["true", "false", "false"]);
    expect([...app.querySelectorAll<HTMLElement>(".herd-group-body")].map(node => node.hidden)).toEqual([false, true, true]);
    act(() => headings()[1].click());
    // Canonical owner getter: the fold landed in the preferences record.
    expect(preferencesStore.get().listGroupCollapsed.beta).toBe(false);
    // Subscription visibility: the typed fold published and the mounted list
    // re-rendered inside the click act — no manual commit makes it visible.
    expect(headings()[1].getAttribute("aria-expanded")).toBe("true");
    expect((app.querySelectorAll(".herd-group-body")[1] as HTMLElement).hidden).toBe(false);
    expect(app.querySelector(".section-title") === null).toBe(true);
  });
});
