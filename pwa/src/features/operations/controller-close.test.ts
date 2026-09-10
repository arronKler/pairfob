import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { AgentCard } from "../../lib/ranking";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { attachLiveSession, liveSession, setCredential } from "../computers/catalog-store";
import { setNetworkOnline, setPhase } from "../connection/connection-store";
import { applyCapabilities, setOperationBusy } from "./capabilities-store";
import { applySnapshot, dashboardStore, replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { selectPane, openPaneId, setFullTerminal, resetPaneView, resetObservationLifecycle } from "../session/session-store";
import { cacheAgentTrace, cachedAgentTrace } from "../../lib/agent-trace-cache";
import { resetGenerationsForTests } from "../connection/generations";
import { closePane, closeTab, closeWorkspace, createSelectedTab, renamePane } from "./controller";

beforeEach(async () => {
  await resetBoardTestDOM();
  resetGenerationsForTests();
});

function agent(partial: Partial<AgentCard> & Pick<AgentCard, "paneId">): AgentCard {
  return {
    agent: "claude",
    status: "idle",
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
    workspaceId: "w1",
    tabId: "t1",
    ...partial,
  };
}

const p1 = agent({ paneId: "p1", paneLabel: "one" });
const p2 = agent({ paneId: "p2", paneLabel: "two", tabId: "t2", workspaceId: "w2" });
const p1b = agent({ paneId: "p1b", paneLabel: "split", tabId: "t1" });

function cache(paneId: string): void {
  cacheAgentTrace(paneId, { items: [], nextCursor: null, note: paneId, truncated: false, signature: paneId, tail: 0 });
}

function boot(open: AgentCard, extras: AgentCard[] = []): void {
  setPhase("live");
  setScreen("pane");
  selectPane(open.paneId);
  setNetworkOnline(true);
  setOperationBusy(false);
  // Seed the herd through the typed dashboard action so store snapshots that
  // the operations controller reads are coherent.
  replaceAgentsFromSnapshot({
    panes: [open, ...extras].map((item) => ({
      pane_id: item.paneId,
      workspace_id: item.workspaceId,
      tab_id: item.tabId,
      agent: item.agent,
      label: item.paneLabel,
    })),
  });
  const herd = (next: readonly { paneId: string }[]) =>
    ({ panes: next.map((item) => ({
      pane_id: item.paneId,
      workspace_id: (item as AgentCard).workspaceId,
      tab_id: (item as AgentCard).tabId,
      agent: (item as AgentCard).agent,
      label: (item as AgentCard).paneLabel,
    })) });
  const session = {
    isConnected: () => true,
    snapshot: async () => herd(dashboardAgents()),
    paneRead: async () => ({ text: "", hash: "" }),
    renamePane: async () => undefined,
    closePane: async () => undefined,
    closeTab: async () => undefined,
    closeWorkspace: async () => undefined,
  };
  attachLiveSession(session);
}

function dashboardAgents() {
  return dashboardStore.get().agents as unknown as readonly { paneId: string }[];
}

/**
 * Drive the danger confirm dialog. The modal owns its own React root
 * (`presentModal` mounts a portal via `flushSync`), so the click that closes it
 * runs inside `act` to keep the root update on the test's act stack.
 */
async function confirmDanger(): Promise<void> {
  await Promise.resolve();
  const dialog = happy.document.querySelector("dialog.modal");
  if (!(dialog instanceof happy.HTMLDialogElement)) throw new Error("missing confirm");
  const go = [...dialog.querySelectorAll("button")].find((button) => button.className.includes("btn-danger"));
  if (!(go instanceof happy.HTMLButtonElement)) throw new Error("missing danger confirm");
  await act(async () => { go.click(); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  for (const dialog of happy.document.querySelectorAll("dialog")) dialog.close("cancel");
  await new Promise((resolve) => setTimeout(resolve, 0));
  attachLiveSession(null);
  setCredential(null);
  selectPane("");
  setScreen("home");
  applySnapshot({ panes: [] });
  setOperationBusy(false);
  setFullTerminal(false);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  resetPaneView();
  resetObservationLifecycle();
});

describe("object mutations target the given pane", () => {
  test("closing another pane does not abandon the open one", async () => await act(async () => {
    boot(p1, [p2]);
    cache("p1");
    cache("p2");
    const closed: string[] = [];
    attachLiveSession({
      ...liveSession()!,
      closePane: async (paneId: string) => { closed.push(paneId); },
      snapshot: async () => ({ panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude" }] }),
    });
    let done!: Promise<void>;
    act(() => { done = closePane(p2); });
    await confirmDanger();
    await done;
    expect(closed).toEqual(["p2"]);
    expect(openPaneId()).toBe("p1");
    expect(currentScreen()).toBe("pane");
    expect(cachedAgentTrace("p2")).toBeNull();
    expect(cachedAgentTrace("p1")?.note).toBe("p1");
  }));

  test("closing the open pane returns to the list", async () => await act(async () => {
    boot(p1, [p2]);
    let done!: Promise<void>;
    act(() => { done = closePane(p1); });
    await confirmDanger();
    await done;
    expect(openPaneId()).toBe("");
    expect(currentScreen()).toBe("home");
  }));

  test("closing the highlighted pane on the list keeps the list", async () => await act(async () => {
    boot(p1, [p2]);
    setScreen("home");
    let done!: Promise<void>;
    act(() => { done = closePane(p1); });
    await confirmDanger();
    await done;
    expect(openPaneId()).toBe("");
    expect(currentScreen()).toBe("home");
  }));

  test("closing a tab only drops panes in that tab", async () => await act(async () => {
    boot(p2, [p1, p1b]);
    cache("p1");
    cache("p1b");
    cache("p2");
    const closed: string[] = [];
    attachLiveSession({
      ...liveSession()!,
      closeTab: async (tabId: string) => { closed.push(tabId); },
      snapshot: async () => ({ panes: [{ pane_id: "p2", workspace_id: "w2", tab_id: "t2", agent: "claude" }] }),
    });
    let done!: Promise<void>;
    act(() => { done = closeTab(p1); });
    await confirmDanger();
    await done;
    expect(closed).toEqual(["t1"]);
    expect(openPaneId()).toBe("p2");
    expect(currentScreen()).toBe("pane");
    expect(cachedAgentTrace("p1")).toBeNull();
    expect(cachedAgentTrace("p1b")).toBeNull();
    expect(cachedAgentTrace("p2")?.note).toBe("p2");
  }));

  test("closing a workspace drops every pane in that workspace", async () => await act(async () => {
    boot(p2, [p1, p1b]);
    cache("p1");
    cache("p1b");
    cache("p2");
    const closed: string[] = [];
    attachLiveSession({
      ...liveSession()!,
      closeWorkspace: async (workspaceId: string) => { closed.push(workspaceId); },
      snapshot: async () => ({ panes: [{ pane_id: "p2", workspace_id: "w2", tab_id: "t2", agent: "claude" }] }),
    });
    let done!: Promise<void>;
    act(() => { done = closeWorkspace(p1); });
    await confirmDanger();
    await done;
    expect(closed).toEqual(["w1"]);
    expect(openPaneId()).toBe("p2");
    expect(currentScreen()).toBe("pane");
    expect(cachedAgentTrace("p1")).toBeNull();
    expect(cachedAgentTrace("p1b")).toBeNull();
    expect(cachedAgentTrace("p2")?.note).toBe("p2");
  }));

  test("create tab uses the card workspace, not the open pane", async () => await act(async () => {
    boot(p1, [p2]);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []);
    const created: Array<{ workspace_id: string; cwd?: string }> = [];
    attachLiveSession({
      ...liveSession()!,
      createTab: async (params: { workspace_id: string; cwd?: string }) => {
        created.push(params);
        return {};
      },
    });
    let done!: Promise<void>;
    act(() => { done = createSelectedTab(p2); });
    await Promise.resolve();
    const dialog = happy.document.querySelector("dialog.operation-modal");
    const form = dialog?.querySelector("form");
    if (!(form instanceof happy.HTMLFormElement)) throw new Error("missing create-tab form");
    await act(async () => { form.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true })); });
    await done;
    expect(created).toEqual([{ workspace_id: "w2", cwd: "/tmp/demo" }]);
    expect(openPaneId()).toBe("p1");
    expect(currentScreen()).toBe("pane");
  }));

  test("rename uses the card pane id, not the open pane", async () => await act(async () => {
    boot(p1, [p2]);
    const renamed: Array<{ paneId: string; label: string | null }> = [];
    attachLiveSession({
      ...liveSession()!,
      renamePane: async (paneId: string, label: string | null) => {
        renamed.push({ paneId, label });
      },
    });
    let done!: Promise<void>;
    act(() => { done = renamePane(p2); });
    await Promise.resolve();
    const dialog = happy.document.querySelector("dialog.modal");
    const input = dialog?.querySelector("input");
    if (!(dialog instanceof happy.HTMLDialogElement) || !(input instanceof happy.HTMLInputElement)) {
      throw new Error("missing rename dialog");
    }
    input.value = "other";
    await act(async () => { dialog.close("ok"); });
    await done;
    expect(renamed).toEqual([{ paneId: "p2", label: "other" }]);
    expect(openPaneId()).toBe("p1");
    expect(currentScreen()).toBe("pane");
  }));
});
