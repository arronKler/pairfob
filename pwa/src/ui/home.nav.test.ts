import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
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
g.history = happy.history;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderHome } = await import("./home.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../lib/operations.ts");

function boot(): void {
  state.phase = "live";
  state.screen = "home";
  state.paneId = "p1";
  state.listGroup = "flat";
  state.operationBusy = false;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  state.agents = [
    { paneId: "p1", agent: "claude", status: "idle", workspaceLabel: "alpha", cwd: "/tmp/a", workspaceId: "w1", tabId: "t1", paneLabel: "one" },
    { paneId: "p2", agent: "claude", status: "idle", workspaceLabel: "beta", cwd: "/tmp/b", workspaceId: "w2", tabId: "t2", paneLabel: "two" },
    { paneId: "p2b", agent: "claude", status: "idle", workspaceLabel: "beta", cwd: "/tmp/b", workspaceId: "w2", tabId: "t2", paneLabel: "two-b" },
  ];
  state.live = {
    isConnected: () => true,
    snapshot: async () => ({ panes: [] }),
    closePane: async () => undefined,
    closeTab: async () => undefined,
    renamePane: async () => undefined,
    renameTab: async () => undefined,
    renameWorkspace: async () => undefined,
  };
  setRenderer(() => renderHome());
  renderHome();
}

afterEach(() => {
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  state.live = null;
  state.agents = [];
  state.paneId = "";
  app.replaceChildren();
});

describe("session list object controls", () => {
  test("the card body opens the session; the trailing control is not the card", () => {
    boot();
    const cards = [...app.querySelectorAll("article.card")];
    expect(cards).toHaveLength(3);
    expect(cards[0]?.getAttribute("role")).toBeNull();
    const more = app.querySelector('button[aria-label="two的操作"]');
    expect(more).toBeTruthy();
    expect(app.querySelector(".card-main")).toBeTruthy();
    expect(app.querySelector(".card-split")).toBeTruthy();
  });

  test("a card menu is titled with that session and can rename a default tab", () => {
    boot();
    const more = app.querySelector('button[aria-label="one的操作"]');
    if (!(more instanceof HTMLButtonElement)) throw new Error("missing card menu");
    more.click();
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.querySelector(".modal-title")?.textContent).toBe("one");
    expect(sheet?.textContent).toContain("改会话名");
    expect(sheet?.textContent).toContain("关闭这个会话");
    expect(sheet?.textContent).toContain("改标签页名");
    expect(sheet?.textContent).not.toContain("关闭整个标签页");
    expect(sheet?.textContent).toContain("改工作区名");
    expect(sheet?.textContent).not.toContain("Worktree");
    expect(sheet?.textContent).not.toContain("新建标签页");
  });

  test("a split tab offers closing the whole tab", () => {
    boot();
    const more = app.querySelector('button[aria-label="two的操作"]');
    if (!(more instanceof HTMLButtonElement)) throw new Error("missing split card menu");
    more.click();
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.textContent).toContain("关闭整个标签页");
  });
});
