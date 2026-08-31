import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentCard } from "./lib/ranking.ts";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
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

const { state } = await import("./state.ts");
const { setRenderer } = await import("./paint.ts");
const { cacheAgentTrace, cachedAgentTrace } = await import("./lib/agent-trace-cache.ts");
const { closePane, closeTab, renamePane } = await import("./live-operations.ts");

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
  cacheAgentTrace(paneId, { items: [], nextCursor: null, note: paneId, signature: paneId, tail: 0 });
}

function boot(open: AgentCard, extras: AgentCard[] = []): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = open.paneId;
  state.networkOnline = true;
  state.operationBusy = false;
  state.agents = [open, ...extras];
  state.live = {
    isConnected: () => true,
    snapshot: async () => ({
      panes: state.agents.map((item) => ({
        pane_id: item.paneId,
        workspace_id: item.workspaceId,
        tab_id: item.tabId,
        agent: item.agent,
        label: item.paneLabel,
      })),
    }),
    paneRead: async () => ({ text: "", hash: "" }),
    renamePane: async () => undefined,
    closePane: async () => undefined,
    closeTab: async () => undefined,
  };
  setRenderer(() => undefined);
}

async function confirmDanger(): Promise<void> {
  await Promise.resolve();
  const dialog = happy.document.querySelector("dialog.modal");
  if (!(dialog instanceof happy.HTMLDialogElement)) throw new Error("missing confirm");
  const go = [...dialog.querySelectorAll("button")].find((button) => button.className.includes("btn-danger"));
  if (!(go instanceof happy.HTMLButtonElement)) throw new Error("missing danger confirm");
  go.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const dialog of happy.document.querySelectorAll("dialog")) dialog.remove();
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.agents = [];
  state.operationBusy = false;
  state.fullTerminal = false;
});

describe("object mutations target the given pane", () => {
  test("closing another pane does not abandon the open one", async () => {
    boot(p1, [p2]);
    cache("p1");
    cache("p2");
    const closed: string[] = [];
    const session = state.live!;
    state.live = {
      ...session,
      closePane: async (paneId: string) => {
        closed.push(paneId);
      },
      snapshot: async () => ({ panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude" }] }),
    };
    const done = closePane(p2);
    await confirmDanger();
    await done;
    expect(closed).toEqual(["p2"]);
    expect(state.paneId).toBe("p1");
    expect(state.screen).toBe("pane");
    expect(cachedAgentTrace("p2")).toBeNull();
    expect(cachedAgentTrace("p1")?.note).toBe("p1");
  });

  test("closing the open pane returns to the list", async () => {
    boot(p1, [p2]);
    const done = closePane(p1);
    await confirmDanger();
    await done;
    expect(state.paneId).toBe("");
    expect(state.screen).toBe("home");
  });

  test("closing the highlighted pane on the list keeps the list", async () => {
    boot(p1, [p2]);
    state.screen = "home";
    const done = closePane(p1);
    await confirmDanger();
    await done;
    expect(state.paneId).toBe("");
    expect(state.screen).toBe("home");
  });

  test("closing a tab only drops panes in that tab", async () => {
    boot(p2, [p1, p1b]);
    cache("p1");
    cache("p1b");
    cache("p2");
    const closed: string[] = [];
    const session = state.live!;
    state.live = {
      ...session,
      closeTab: async (tabId: string) => {
        closed.push(tabId);
      },
      snapshot: async () => ({ panes: [{ pane_id: "p2", workspace_id: "w2", tab_id: "t2", agent: "claude" }] }),
    };
    const done = closeTab(p1);
    await confirmDanger();
    await done;
    expect(closed).toEqual(["t1"]);
    expect(state.paneId).toBe("p2");
    expect(state.screen).toBe("pane");
    expect(cachedAgentTrace("p1")).toBeNull();
    expect(cachedAgentTrace("p1b")).toBeNull();
    expect(cachedAgentTrace("p2")?.note).toBe("p2");
  });

  test("rename uses the card pane id, not the open pane", async () => {
    boot(p1, [p2]);
    const renamed: Array<{ paneId: string; label: string | null }> = [];
    const session = state.live!;
    state.live = {
      ...session,
      renamePane: async (paneId: string, label: string | null) => {
        renamed.push({ paneId, label });
      },
    };
    const done = renamePane(p2);
    await Promise.resolve();
    const dialog = happy.document.querySelector("dialog.modal");
    const input = dialog?.querySelector("input");
    if (!(dialog instanceof happy.HTMLDialogElement) || !(input instanceof happy.HTMLInputElement)) {
      throw new Error("missing rename dialog");
    }
    input.value = "other";
    dialog.close("ok");
    await done;
    expect(renamed).toEqual([{ paneId: "p2", label: "other" }]);
    expect(state.paneId).toBe("p1");
    expect(state.screen).toBe("pane");
  });
});
