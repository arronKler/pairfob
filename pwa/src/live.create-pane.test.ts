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
const { startNewConversation } = await import("./live-operations.ts");

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
  state.operationCapabilities = { ...state.operationCapabilities, create_conversation: true, history: true };
  state.agentKinds = ["codex"];
  state.agents = [
    { paneId: "p1", agent: "", hasAgent: false, status: "idle", workspaceLabel: "demo", cwd: "/tmp/demo" },
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
  };
  setRenderer(paint);
  paint();
}

async function submitConversationForm(cwd: string): Promise<void> {
  const dialog = happy.document.querySelector("dialog.operation-modal");
  if (!(dialog instanceof happy.HTMLDialogElement)) throw new Error("missing create-conversation dialog");
  const field = dialog.querySelector('input[name="cwd"]');
  if (!(field instanceof happy.HTMLInputElement)) throw new Error("missing cwd field");
  field.value = cwd;
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
    await submitConversationForm("/tmp/demo");
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
    await submitConversationForm("/tmp/demo");
    await created;

    expect(state.paneId).toBe("p2");
    expect(state.agentChat).toBe(false);
    expect(app.querySelector(".agent-chat-root")).toBeNull();
    expect(app.querySelector(".term")).toBeTruthy();
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
  setDefaultTermMode("guided");
  app.replaceChildren();
});
