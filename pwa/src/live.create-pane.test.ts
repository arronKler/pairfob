import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "HTMLDetailsElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.FormData = happy.FormData;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, setDefaultTermMode, state } = await import("./state.ts");
const { setRenderer } = await import("./paint.ts");
const { renderHome } = await import("./ui/home.ts");
const { renderPane } = await import("./ui/pane.ts");
const { createSelectedTab, splitSelectedPane, startNewConversation } = await import("./live-operations.ts");
const { LAST_AGENT_KIND_KEY } = await import("./lib/operation-ui.ts");

function paint(): void {
  if (state.screen === "pane") renderPane();
  else renderHome();
}

const SNAPSHOT_TWO_PANES = {
  workspaces: [{ workspace_id: "w1", label: "demo" }, { workspace_id: "w2", label: "demo" }],
  panes: [
    { pane_id: "p1", workspace_id: "w1", agent: "", agent_status: "idle" },
    { pane_id: "p2", workspace_id: "w2", agent: "codex", agent_status: "idle", history_available: true },
  ],
};

function boot(): void {
  state.phase = "live";
  state.screen = "home";
  state.paneId = "";
  state.networkOnline = true;
  state.snapshotAt = Date.now();
  state.operationCapabilities = {
    ...state.operationCapabilities,
    create_conversation: true,
    create_tab: true,
    split_pane: true,
    history: true,
  };
  state.agentKinds = ["codex"];
  state.agents = [
    { paneId: "p1", agent: "", hasAgent: false, status: "idle", workspaceLabel: "demo", cwd: "/tmp/demo", workspaceId: "w1" },
  ];
  state.live = {
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
  };
  setRenderer(paint);
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
  test("new conversations honor the default agent-chat mode", async () => {
    boot();
    setDefaultTermMode("agent");

    const created = startNewConversation();
    await submitOperationForm({ cwd: "/tmp/demo" });
    await created;

    expect(state.paneId).toBe("p2");
    expect(state.screen).toBe("pane");
    expect(state.agentChat).toBe(true);
    expect(state.fullTerminal).toBe(false);
    expect(app.querySelector(".agent-chat-root")).toBeTruthy();
  });

  test("new conversations honor the guided default", async () => {
    boot();
    setDefaultTermMode("guided");

    const created = startNewConversation();
    await submitOperationForm({ cwd: "/tmp/demo" });
    await created;

    expect(state.paneId).toBe("p2");
    expect(state.agentChat).toBe(false);
    expect(app.querySelector(".agent-chat-root")).toBeNull();
    expect(app.querySelector(".term")).toBeTruthy();
  });

  test("new conversations use the safe Control fallback for Auto before P2P is active", async () => {
    boot();
    state.sessionTransport = "relay";
    setDefaultTermMode("auto");

    const created = startNewConversation();
    await submitOperationForm({ cwd: "/tmp/demo" });
    await created;

    expect(state.paneId).toBe("p2");
    expect(state.agentChat).toBe(false);
    expect(state.fullTerminal).toBe(false);
    expect(app.querySelector(".term")).toBeTruthy();
  });
});

describe("new tabs and splits preserve the frozen terminal-only contract", () => {
  test("create tab neither renders nor sends agent_kind", async () => {
    boot();
    localStorage.setItem(LAST_AGENT_KIND_KEY, "codex");
    const created: Array<Record<string, unknown>> = [];
    const session = state.live!;
    state.live = {
      ...session,
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
    };
    const done = createSelectedTab(state.agents[0]);
    expect(happy.document.querySelector('select[name="agent_kind"]')).toBeNull();
    await submitOperationForm();
    await done;
    expect(created).toEqual([{ workspace_id: "w1", cwd: "/tmp/demo" }]);
    expect(state.paneId).toBe("p2");
  });

  test("split pane neither renders nor sends agent_kind", async () => {
    boot();
    localStorage.setItem(LAST_AGENT_KIND_KEY, "codex");
    state.paneId = "p1";
    const created: Array<Record<string, unknown>> = [];
    const session = state.live!;
    state.live = {
      ...session,
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
    };
    const done = splitSelectedPane();
    expect(happy.document.querySelector('select[name="agent_kind"]')).toBeNull();
    await submitOperationForm();
    await done;
    expect(created).toEqual([{ pane_id: "p1", direction: "right", ratio: 0.5, cwd: "/tmp/demo" }]);
    expect(state.paneId).toBe("p2");
  });
});

afterEach(() => {
  for (const dialog of happy.document.querySelectorAll("dialog")) dialog.remove();
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.agents = [];
  state.agentChat = false;
  state.fullTerminal = false;
  state.agentTraceItems = [];
  state.agentTraceLoadState = "cold";
  state.agentTraceSig = "";
  state.agentTraceTail = 0;
  state.operationBusy = false;
  state.sessionTransport = "relay";
  setDefaultTermMode("auto");
  localStorage.removeItem(LAST_AGENT_KIND_KEY);
  app.replaceChildren();
});
