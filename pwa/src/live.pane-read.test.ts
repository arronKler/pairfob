import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/", width: 1280, height: 800 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { state } = await import("./state.ts");
const { setRenderer } = await import("./paint.ts");
const { refreshPaneRead } = await import("./live.ts");

let renders = 0;
setRenderer(() => {
  renders += 1;
});

function bootDeskPane(status: "idle" | "done"): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.networkOnline = true;
  state.snapshotAt = Date.now();
  state.composeDraft = "";
  state.composeFocused = false;
  state.composeIME = false;
  state.agents = [
    { paneId: "p1", agent: "codex", hasAgent: true, status, workspaceLabel: "demo", cwd: "/tmp/demo" },
  ];
  state.runtimeAgentStatuses = { p1: status };
  state.completionSeen = {};
  state.live = {
    isConnected: () => true,
    paneRead: async () => ({ text: "hello", hash: "a".repeat(64) }),
  };
}

/**
 * The pane-read poll fires every 1.5s while a pane is open. On desk, an
 * unchanged screen used to trigger a full remount whenever the compose field
 * was not focused, which wiped an in-progress terminal text selection and
 * stole focus. Only a fresh completion acknowledgment may repaint now.
 */
describe("desk pane reads on an idle screen", () => {
  test("an unchanged screen no longer remounts the pane", async () => {
    bootDeskPane("idle");
    await refreshPaneRead();
    expect(state.paneText).toBe("hello");

    renders = 0;
    await refreshPaneRead();
    expect(renders).toBe(0);
  });

  test("a fresh completion repaints exactly once, then goes quiet", async () => {
    bootDeskPane("idle");
    await refreshPaneRead();

    renders = 0;
    state.agents[0].status = "done";
    state.runtimeAgentStatuses = { p1: "done" };
    await refreshPaneRead();
    expect(renders).toBe(1);

    renders = 0;
    await refreshPaneRead();
    expect(renders).toBe(0);
  });
});

afterEach(() => {
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.agents = [];
  state.runtimeAgentStatuses = {};
  state.completionSeen = {};
  state.paneText = "";
  state.paneHash = "";
  renders = 0;
});
