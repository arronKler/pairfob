import { happy, resetChatDOM } from "../../../test-support/chat-dom";
import { act } from "react";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { LAST_AGENT_KIND_KEY } from "./operation-ui";
import { setLang } from "../../lib/i18n";
import { attachLiveSession, liveSession, setCredential } from "../computers/catalog-store";
import { setNetworkOnline, setPhase, setSessionTransport } from "../connection/connection-store";
import { applyCapabilities, setOperationBusy } from "./capabilities-store";
import { dashboardStore, replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { setDefaultTermMode } from "../settings/preferences-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { isAgentChat, isFullTerminal, noteSnapshotAt, openPaneId, selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { resetTrace } from "../session/chat/trace-store";
import { resetGenerationsForTests } from "../connection/generations";
import { mountApp, unmountApp } from "../../app/mount";
import { commitView } from "../../app/host";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../session/register";
import { createSelectedTab, splitSelectedPane, startNewConversation } from "./controller";

beforeEach(async () => {
  await resetChatDOM();
  setLang("zh");
  // Production binds the session feature's owner adoption on the frame seam
  // before the first mount; the real App prepares pane ownership through it.
  registerSessionOwnerPreparer(registerSessionView);
});

function app(): HTMLElement {
  return document.getElementById("app") as HTMLElement;
}

/** Mount the real App and commit: the real installed host drives commitView. */
function paint(): void {
  act(() => { mountApp(); commitView(); });
}

const SNAPSHOT_TWO_PANES = {
  workspaces: [{ workspace_id: "w1", label: "demo" }, { workspace_id: "w2", label: "demo" }],
  panes: [
    { pane_id: "p1", workspace_id: "w1", agent: "", agent_status: "idle" },
    { pane_id: "p2", workspace_id: "w2", agent: "codex", agent_status: "idle", history_available: true },
  ],
};

function boot(): void {
  setPhase("live");
  setScreen("home");
  selectPane("");
  setNetworkOnline(true);
  noteSnapshotAt(Date.now());
  applyCapabilities(
    { ...NO_OPERATION_CAPABILITIES, create_conversation: true, create_tab: true, split_pane: true, history: true },
    ["codex"],
  );
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    panes: [
      { pane_id: "p1", workspace_id: "w1", agent: "", agent_status: "idle", cwd: "/tmp/demo" },
    ],
  });
  attachLiveSession({
    isConnected: () => true,
    snapshot: async () => SNAPSHOT_TWO_PANES,
    paneRead: async (paneId: string) => ({ text: `screen of ${paneId}`, hash: `h-${paneId}` }),
    agentTrace: async () => ({ items: [], nextCursor: null, truncated: false }),
    createConversation: async () => ({
      operation_id: "op_AAECAwQFBgcICQoL",
      workspace_id: "w2",
      tab_id: "t2",
      pane_id: "p2",
      outcome: "applied",
    }),
    createTab: async () => ({
      operation_id: "op_tab000000000001",
      workspace_id: "w1",
      tab_id: "t3",
      pane_id: "p2",
      outcome: "applied",
    }),
    splitPane: async () => ({
      operation_id: "op_split0000000001",
      workspace_id: "w1",
      tab_id: "t1",
      pane_id: "p2",
      outcome: "applied",
    }),
  });
  paint();
}

async function submitOperationForm(options: { cwd?: string; agentKind?: string } = {}): Promise<void> {
  const dialog = happy.document.querySelector("dialog.operation-modal");
  if (!(dialog instanceof happy.HTMLDialogElement)) throw new Error("missing operation dialog");
  if (options.cwd !== undefined) {
    const field = dialog.querySelector('input[name="cwd"]');
    if (!(field instanceof happy.HTMLInputElement)) throw new Error("missing cwd field");
    field.value = options.cwd;
  }
  if (options.agentKind !== undefined) {
    const kind = dialog.querySelector('select[name="agent_kind"]');
    if (!(kind instanceof happy.HTMLSelectElement)) throw new Error("missing agent kind field");
    kind.value = options.agentKind;
  }
  const form = dialog.querySelector("form");
  if (!(form instanceof happy.HTMLFormElement)) throw new Error("missing form");
  form.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }));
}

/**
 * Creating a pane used to skip the normal open path, so it ignored the
 * remembered / default view mode and always landed in the guided view.
 */
describe("a created pane opens through the normal pane-open path", () => {
  test("creation conflicts explain startup failure and never replay the mutation", async () => await act(async () => {
    boot();
    const { ProtocolError } = await import("../../lib/protocol/errors");
    let calls = 0;
    attachLiveSession({
      ...liveSession()!,
      createConversation: async () => {
        calls += 1;
        throw new ProtocolError("conflict", "runtime rejected startup");
      },
    });
    const created = startNewConversation();
    await submitOperationForm({ cwd: "/tmp/demo", agentKind: "codex" });
    await created;
    expect(calls).toBe(1);
    expect(currentScreen()).toBe("home");
    expect(app().textContent).toContain("创建会话失败");
    expect(app().textContent).not.toContain("画面已经变化");
  }));

  test("new conversations honor the default agent-chat mode", async () => await act(async () => {
    boot();
    setDefaultTermMode("agent");

    const created = startNewConversation();
    await submitOperationForm({ cwd: "/tmp/demo" });
    await created;

    expect(openPaneId()).toBe("p2");
    expect(currentScreen()).toBe("pane");
    expect(isAgentChat()).toBe(true);
    expect(isFullTerminal()).toBe(false);
    expect(app().querySelector(".agent-chat-root")).toBeTruthy();
  }));

  test("new conversations honor the guided default", async () => await act(async () => {
    boot();
    setDefaultTermMode("guided");

    const created = startNewConversation();
    await submitOperationForm({ cwd: "/tmp/demo" });
    await created;

    expect(openPaneId()).toBe("p2");
    expect(isAgentChat()).toBe(false);
    expect(app().querySelector(".agent-chat-root")).toBeNull();
    expect(app().querySelector(".term")).toBeTruthy();
  }));

  test("new conversations use the safe Control fallback for Auto before P2P is active", async () => await act(async () => {
    boot();
    setSessionTransport("relay");
    setDefaultTermMode("auto");

    const created = startNewConversation();
    await submitOperationForm({ cwd: "/tmp/demo" });
    await created;

    expect(openPaneId()).toBe("p2");
    expect(isAgentChat()).toBe(false);
    expect(isFullTerminal()).toBe(false);
    expect(app().querySelector(".term")).toBeTruthy();
  }));
});

describe.each(["", "codex"])("new tabs and splits with pane kind %s", (agentKind) => {
  test("create tab sends the selected pane kind", async () => await act(async () => {
    boot();
    localStorage.setItem(LAST_AGENT_KIND_KEY, "codex");
    const created: Array<Record<string, unknown>> = [];
    attachLiveSession({
      ...liveSession()!,
      createTab: async (params) => {
        created.push(params);
        return {
          operation_id: "op_tabshell00000001",
          workspace_id: "w1",
          tab_id: "t3",
          pane_id: "p2",
          outcome: "applied" as const,
        };
      },
    });
    const done = createSelectedTab(dashboardStore.get().agents[0]);
    expect(happy.document.querySelector('select[name="agent_kind"]')?.getAttribute("name")).toBe("agent_kind");
    await submitOperationForm({ agentKind });
    await done;
    expect(created).toEqual([{ workspace_id: "w1", cwd: "/tmp/demo", ...(agentKind ? { agent_kind: agentKind } : {}) }]);
    expect(localStorage.getItem(LAST_AGENT_KIND_KEY)).toBe(agentKind);
    expect(openPaneId()).toBe("p2");
  }));

  test("split pane sends the selected pane kind", async () => await act(async () => {
    boot();
    localStorage.setItem(LAST_AGENT_KIND_KEY, "codex");
    selectPane("p1");
    const created: Array<Record<string, unknown>> = [];
    attachLiveSession({
      ...liveSession()!,
      splitPane: async (params) => {
        created.push(params);
        return {
          operation_id: "op_splitshell000001",
          workspace_id: "w1",
          tab_id: "t1",
          pane_id: "p2",
          outcome: "applied" as const,
        };
      },
    });
    const done = splitSelectedPane();
    expect(happy.document.querySelector('select[name="agent_kind"]')?.getAttribute("name")).toBe("agent_kind");
    await submitOperationForm({ agentKind });
    await done;
    expect(created).toEqual([{ pane_id: "p1", direction: "right", ratio: 0.5, cwd: "/tmp/demo", ...(agentKind ? { agent_kind: agentKind } : {}) }]);
    expect(localStorage.getItem(LAST_AGENT_KIND_KEY)).toBe(agentKind);
    expect(openPaneId()).toBe("p2");
  }));
});

describe.each(["tab", "split"])("%s pane type form", (operation) => {
  function open(): Promise<void> {
    selectPane("p1");
    return operation === "tab" ? createSelectedTab() : splitSelectedPane();
  }

  function kindField(): InstanceType<typeof happy.HTMLSelectElement> {
    const field = happy.document.querySelector('select[name="agent_kind"]');
    if (!(field instanceof happy.HTMLSelectElement)) throw new Error("missing pane type");
    return field;
  }

  function cancel(): void {
    const dialog = happy.document.querySelector("dialog.operation-modal");
    if (!(dialog instanceof happy.HTMLDialogElement)) throw new Error("missing dialog");
    dialog.close("cancel");
  }

  test("offers every advertised kind and remembers the last supported choice", async () => await act(async () => {
    boot();
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true, create_tab: true, split_pane: true, history: true }, ["codex", "claude"]);
    localStorage.setItem(LAST_AGENT_KIND_KEY, "claude");
    const done = open();
    expect([...kindField().options].map((option) => option.value)).toEqual(["", "codex", "claude"]);
    expect(kindField().value).toBe("claude");
    kindField().value = "codex";
    cancel();
    await done;
    expect(localStorage.getItem(LAST_AGENT_KIND_KEY)).toBe("claude");
    expect(openPaneId()).toBe("p1");
  }));

  test("keeps the terminal type visible when no agents are available", async () => await act(async () => {
    boot();
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true, create_tab: true, split_pane: true, history: true }, []);
    localStorage.setItem(LAST_AGENT_KIND_KEY, "codex");
    const done = open();
    expect([...kindField().options].map((option) => option.value)).toEqual([""]);
    expect(kindField().value).toBe("");
    await submitOperationForm();
    await done;
    expect(openPaneId()).toBe("p2");
  }));

  test("rejects an unadvertised kind before creating anything", async () => await act(async () => {
    boot();
    const done = open();
    const option = happy.document.createElement("option");
    option.value = "unavailable";
    kindField().append(option);
    await submitOperationForm({ agentKind: "unavailable" });
    expect(kindField().getAttribute("aria-invalid")).toBe("true");
    expect(openPaneId()).toBe("p1");
    expect(localStorage.getItem(LAST_AGENT_KIND_KEY)).toBeNull();
    cancel();
    await done;
  }));
});

afterEach(() => {
  act(() => { closeTestDialogs(); unmountApp(); registerSessionOwnerPreparer(null); });
  attachLiveSession(null);
  setCredential(null);
  selectPane("");
  setScreen("home");
  replaceAgentsFromSnapshot({ panes: [] });
  setAgentChat(false);
  setFullTerminal(false);
  resetTrace();
  setOperationBusy(false);
  setSessionTransport("relay");
  setDefaultTermMode("auto");
  localStorage.removeItem(LAST_AGENT_KIND_KEY);
  resetGenerationsForTests();
  app().replaceChildren();
});