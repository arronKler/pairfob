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
  "MouseEvent",
  "PointerEvent",
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
    {
      paneId: "p1",
      agent: "claude",
      status: "idle",
      workspaceLabel: "alpha",
      cwd: "/tmp/a",
      workspaceId: "w1",
      tabId: "t1",
      tabLabel: "main",
      paneLabel: "one",
    },
    {
      paneId: "p2",
      agent: "claude",
      status: "idle",
      workspaceLabel: "beta",
      cwd: "/tmp/b",
      workspaceId: "w2",
      tabId: "t2",
      tabLabel: "review",
      paneLabel: "two",
    },
    {
      paneId: "p2b",
      agent: "claude",
      status: "idle",
      workspaceLabel: "beta",
      cwd: "/tmp/b",
      workspaceId: "w2",
      tabId: "t2",
      tabLabel: "review",
      paneLabel: "two-b",
    },
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

function cardNamed(name: string): HTMLButtonElement {
  const card = [...app.querySelectorAll(".card-main")].find((button) => button.textContent?.includes(name));
  if (!(card instanceof HTMLButtonElement)) throw new Error(`missing card ${name}`);
  return card;
}

afterEach(() => {
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  state.live = null;
  state.agents = [];
  state.paneId = "";
  state.listGroup = "flat";
  app.replaceChildren();
});

describe("session list object controls", () => {
  test("the card is a single open control with no trailing menu button", () => {
    boot();
    expect(app.querySelectorAll("article.card")).toHaveLength(3);
    expect(app.querySelector(".card-more")).toBeNull();
    expect(app.querySelector(".card-split")).toBeNull();
    expect(cardNamed("one").getAttribute("aria-haspopup")).toBe("menu");
  });

  test("a default tab is not offered rename; a named or split tab is", () => {
    boot();
    cardNamed("one").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const plain = document.querySelector("dialog.sheet");
    expect(plain?.querySelector(".modal-title")?.textContent).toBe("one");
    expect(plain?.textContent).toContain("改会话名");
    expect(plain?.textContent).toContain("关闭这个会话");
    expect(plain?.textContent).not.toContain("改标签页名");
    expect(plain?.textContent).not.toContain("关闭整个标签页");
    expect(plain?.textContent).toContain("改工作区名");
    expect(plain?.textContent).not.toContain("取消");
    plain?.remove();

    cardNamed("two").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const split = document.querySelector("dialog.sheet");
    expect(split?.textContent).toContain("改标签页名");
    expect(split?.textContent).toContain("关闭整个标签页");
  });

  test("a hold opens the menu and does not navigate", async () => {
    boot();
    const opened = state.paneId;
    const card = cardNamed("two");
    card.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", button: 0, clientX: 20, clientY: 20 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector("dialog.sheet")?.querySelector(".modal-title")?.textContent).toBe("two");
    card.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", button: 0, clientX: 20, clientY: 20 }));
    card.click();
    expect(state.paneId).toBe(opened);
    expect(state.screen).toBe("home");
  });

  test("workspace grouping moves rename off the card and onto the heading", () => {
    boot();
    state.listGroup = "space";
    renderHome();
    const heading = [...app.querySelectorAll(".group-title")].find((el) => el.textContent?.includes("alpha"));
    if (!(heading instanceof HTMLButtonElement)) throw new Error("missing workspace heading");
    heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.querySelector(".modal-title")?.textContent).toBe("alpha");
    expect(sheet?.textContent).toContain("改工作区名");
    expect(sheet?.textContent).not.toContain("改会话名");
    sheet?.remove();

    cardNamed("one").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const cardSheet = document.querySelector("dialog.sheet");
    expect(cardSheet?.textContent).toContain("改会话名");
    expect(cardSheet?.textContent).not.toContain("改工作区名");
  });
});
