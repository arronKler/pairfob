import { Window } from "happy-dom";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ProtocolError } from "../lib/protocol/errors";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "HTMLDetailsElement",
  "HTMLDialogElement",
  "Node",
  "DocumentFragment",
  "ResizeObserver",
  "MutationObserver",
  "DOMParser",
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
g.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
g.visualViewport = happy.visualViewport;
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, paneTermMode, setPaneTermMode, state } = await import("../state.ts");
const { clearAgentTraceCache } = await import("../lib/agent-trace-cache.ts");
const { setRenderer } = await import("../paint.ts");
const { renderPane, goBackFromPane } = await import("./pane.ts");
const { leaveAgentChat, patchAgentChat, refreshAgentTrace, restoreAgentTrace } = await import("./agent-chat.ts");

function live() {
  return {
    agentTrace: async () => ({
      items: [
        { type: "user" as const, text: "inspect this" },
        { type: "thinking" as const, text: "I will read it" },
        { type: "tool" as const, name: "Read", input: "{\"path\":\"a.ts\"}", output: "ok" },
        { type: "assistant" as const, text: "looks fine" },
      ],
      nextCursor: null,
      truncated: false,
    }),
    promptAgent: async () => ({ operation_id: "op_AAECAwQFBgcICQoL", pane_id: "p1", agent_status: "working", outcome: "applied" }),
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  };
}

function bootAgentChat(): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.composeDraft = "";
  state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: true, history: true };
  state.agents = [{
    paneId: "p1",
    agent: "codex",
    hasAgent: true,
    status: "working",
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
    historyAvailable: true,
  }];
  state.live = live();
  state.fullTerminal = false;
  state.agentChat = true;
  state.agentTraceLoadState = "ready";
  state.agentTraceItems = [
    { type: "user", text: "inspect this" },
    { type: "thinking", text: "I will read it" },
    { type: "tool", name: "Read", input: "{\"path\":\"a.ts\"}", output: "ok" },
    { type: "assistant", text: "looks fine" },
  ];
  state.agentTraceTail = state.agentTraceItems.length;
  state.agentTraceSig = "seed";
  state.agentTracePending = "";
  state.agentTraceFollow = true;
  state.agentTraceUnread = false;
  setPaneTermMode("p1", "agent");
  setRenderer(() => renderPane());
  renderPane();
}

function click(selector: string): void {
  const el = app.querySelector(selector);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${selector}: ${app.innerHTML.slice(0, 280)}`);
  el.click();
}

beforeAll(() => {
  setRenderer(() => renderPane());
});

afterEach(() => {
  leaveAgentChat({ rememberGuided: false, paint: false });
  state.screen = "pane";
  state.composeDraft = "";
  state.paneTermModes = {};
  state.agentTraceItems = [];
  state.agentTraceLoadState = "cold";
  state.agentTracePending = "";
  state.agentTraceNext = null;
  state.agentTraceFollow = true;
  state.agentTraceBusy = false;
  state.agentTraceNote = "";
  state.notice = null;
  state.live = null;
  clearAgentTraceCache();
  app.replaceChildren();
});

describe("agent-chat remembers its mode per pane", () => {
  test("renders thinking, tools, and the final reply", () => {
    bootAgentChat();
    expect(app.querySelector(".agent-chat-root")).toBeTruthy();
    expect(app.querySelector(".agent-process")).toBeTruthy();
    expect(app.querySelector(".agent-thinking")).toBeTruthy();
    expect(app.querySelector(".agent-tool")).toBeTruthy();
    expect(app.querySelector(".agent-assistant")?.textContent).toContain("looks fine");
    expect(app.querySelector(".agent-user")?.textContent).toContain("inspect this");
    expect(app.querySelector(".agent-user-role")?.textContent).toBe("你");
    expect(app.querySelector(".agent-process-summary")?.textContent).toContain("正在执行");
    expect(app.querySelector(".agent-stream-inner")).toBeTruthy();
    const title = app.querySelector(".agent-chat-root .chrome-title");
    expect(title).toBeTruthy();
    expect(title?.getAttribute("aria-label") || "").toContain("切换会话");
    if (!(title instanceof HTMLButtonElement)) throw new Error("title is not a button");
    title.click();
    expect(document.querySelector("dialog.sheet .modal-title")?.textContent).toBe("切换会话");
    document.querySelector("dialog.sheet")?.remove();
  });

  test("a cold working conversation shows loading instead of the empty call to action", async () => {
    bootAgentChat();
    let finish: ((page: Awaited<ReturnType<ReturnType<typeof live>["agentTrace"]>>) => void) | undefined;
    state.agentTraceItems = [];
    state.agentTraceLoadState = "cold";
    state.agentTraceSig = "";
    state.live = {
      ...live(),
      agentTrace: () => new Promise((resolve) => { finish = resolve; }),
    } as typeof state.live;

    renderPane();
    expect(app.querySelector(".agent-empty-working .agent-empty-title")?.textContent).toBe("正在执行");
    expect(app.querySelector(".agent-empty .spinner")).toBeTruthy();
    expect(app.textContent).not.toContain("还没有对话");

    finish?.({ items: [], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.querySelector(".agent-empty-working")).toBeTruthy();
    expect(app.textContent).not.toContain("还没有对话");
  });

  test("a cold idle conversation uses loading and only shows the empty action after success", async () => {
    bootAgentChat();
    let finish: ((page: { items: []; nextCursor: null; truncated: false }) => void) | undefined;
    state.agents[0].status = "idle";
    state.agentTraceItems = [];
    state.agentTraceLoadState = "cold";
    state.agentTraceSig = "";
    state.live = {
      ...live(),
      agentTrace: () => new Promise((resolve) => { finish = resolve; }),
    } as typeof state.live;

    renderPane();
    expect(app.querySelector(".agent-empty-loading")).toBeTruthy();
    expect(app.querySelector(".agent-empty-title")?.textContent).toBe("正在读取执行过程");
    expect(app.querySelector(".agent-empty .spinner")).toBeTruthy();
    expect(app.textContent).not.toContain("还没有对话");
    expect(app.querySelector(".agent-stream")?.getAttribute("aria-busy")).toBe("true");

    finish?.({ items: [], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.querySelector(".agent-empty-empty .agent-empty-title")?.textContent).toBe("还没有对话");
    expect(app.querySelector(".agent-empty-sub")?.textContent).toContain("在下面");
    expect(app.querySelector(".agent-stream")?.getAttribute("aria-busy")).toBe("false");
  });

  test("returning to a pane paints its last successful trace before refreshing", async () => {
    bootAgentChat();
    await refreshAgentTrace();
    goBackFromPane();
    state.screen = "pane";
    state.paneId = "p1";
    state.agentChat = true;
    expect(restoreAgentTrace("p1")).toBe(true);
    renderPane();
    expect(app.textContent).toContain("looks fine");
    expect(app.textContent).not.toContain("还没有对话");
  });

  test("the newest page paints before background context pagination finishes", async () => {
    bootAgentChat();
    let finishOlder: ((page: { items: Array<{ type: "user"; text: string }>; nextCursor: null; truncated: false }) => void) | undefined;
    state.agentTraceItems = [];
    state.agentTraceLoadState = "cold";
    state.agentTraceSig = "";
    state.live = {
      ...live(),
      agentTrace: async (_paneId: string, cursor: string | null) => {
        if (!cursor) return { items: [{ type: "assistant" as const, text: "newest reply" }], nextCursor: "older-1", truncated: false };
        return new Promise((resolve) => { finishOlder = resolve; });
      },
    } as typeof state.live;

    renderPane();
    await Promise.resolve();
    await Promise.resolve();
    expect(app.textContent).toContain("newest reply");
    expect(state.agentTraceBusy).toBe(true);

    finishOlder?.({ items: [{ type: "user", text: "owning prompt" }], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.textContent).toContain("owning prompt");
  });

  test("a stale pane request cannot replace or unlock the current conversation", async () => {
    bootAgentChat();
    let finishP1: ((page: { items: Array<{ type: "assistant"; text: string }>; nextCursor: null; truncated: false }) => void) | undefined;
    let finishP2: ((page: { items: Array<{ type: "assistant"; text: string }>; nextCursor: null; truncated: false }) => void) | undefined;
    const session = {
      ...live(),
      agentTrace: (paneId: string) => new Promise((resolve) => {
        if (paneId === "p1") finishP1 = resolve;
        else finishP2 = resolve;
      }),
    } as typeof state.live;
    state.agentTraceItems = [];
    state.agentTraceLoadState = "cold";
    state.agentTraceSig = "";
    state.live = session;

    renderPane();
    expect(state.agentTraceBusy).toBe(true);

    leaveAgentChat({ rememberGuided: false, paint: false });
    state.paneId = "p2";
    state.agents = [{ ...state.agents[0], paneId: "p2" }];
    state.agentChat = true;
    state.agentTraceItems = [];
    state.agentTraceLoadState = "cold";
    state.agentTraceSig = "";
    renderPane();
    expect(state.agentTraceBusy).toBe(true);

    finishP1?.({ items: [{ type: "assistant", text: "stale p1 reply" }], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.agentTraceBusy).toBe(true);
    expect(app.textContent).not.toContain("stale p1 reply");

    finishP2?.({ items: [{ type: "assistant", text: "current p2 reply" }], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.agentTraceBusy).toBe(false);
    expect(app.textContent).toContain("current p2 reply");
  });

  test("every turn stays in the stream, including earlier user messages", () => {
    bootAgentChat();
    state.agentTraceItems = [
      { type: "user", text: "first question" },
      { type: "assistant", text: "first answer" },
      { type: "user", text: "inspect this" },
      { type: "thinking", text: "I will read it" },
      { type: "tool", name: "Read", input: "{\"path\":\"a.ts\"}", output: "ok" },
      { type: "assistant", text: "looks fine" },
    ];
    expect(patchAgentChat({ follow: false })).toBe(true);
    const users = [...app.querySelectorAll(".agent-user-text")].map((el) => el.textContent);
    expect(users).toEqual(["first question", "inspect this"]);
    expect(app.querySelectorAll(".agent-assistant")).toHaveLength(2);
  });

  test("older history sits in the stream so it scrolls away from the latest turn", () => {
    bootAgentChat();
    expect(app.querySelector(".agent-chat-root > .agent-older")).toBeNull();
    expect(app.querySelector(".agent-stream-inner > .agent-older")?.hidden).toBe(true);
    state.agentTraceNext = "cursor-1";
    expect(patchAgentChat({ follow: false })).toBe(true);
    const older = app.querySelector(".agent-stream-inner > .agent-older");
    if (!(older instanceof HTMLButtonElement)) throw new Error("missing 加载更早内容");
    expect(older.hidden).toBe(false);
    expect(older.textContent).toBe("加载更早内容");
    expect(older.disabled).toBe(false);
    expect(older).toBe(app.querySelector(".agent-stream-inner")?.firstElementChild);
  });

  test("‹ returns to the session list and keeps agent-chat as the pane mode", () => {
    bootAgentChat();
    click(".chrome .back");
    expect(state.agentChat).toBe(false);
    expect(state.screen).toBe("home");
    expect(paneTermMode("p1")).toBe("agent");
    expect(app.querySelector(".agent-chat-root")).toBeNull();
  });

  test("reopening the pane restores agent-chat", () => {
    bootAgentChat();
    click(".chrome .back");
    state.screen = "pane";
    state.paneId = "p1";
    state.agentChat = paneTermMode("p1") === "agent";
    renderPane();
    expect(state.agentChat).toBe(true);
    expect(app.querySelector(".agent-chat-root")).toBeTruthy();
    expect(app.querySelector(".dock")).toBeTruthy();
  });

  test("退出对话 returns to the guided pane and remembers guided", () => {
    bootAgentChat();
    leaveAgentChat();
    expect(state.agentChat).toBe(false);
    expect(state.screen).toBe("pane");
    expect(paneTermMode("p1")).toBe("guided");
    expect(app.querySelector(".dock")).toBeTruthy();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
  });

  test("swipe-back from agent-chat returns to the list", () => {
    bootAgentChat();
    goBackFromPane();
    expect(state.screen).toBe("home");
    expect(paneTermMode("p1")).toBe("agent");
  });

  test("Enter sends the draft and keeps the same compose field", async () => {
    bootAgentChat();
    const field = app.querySelector(".agent-dock textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing compose");
    field.value = "hello there";
    field.dispatchEvent(new happy.Event("input", { bubbles: true }));
    field.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(app.querySelector(".agent-dock textarea")).toBe(field);
    expect(state.composeDraft).toBe("");
    expect(app.textContent).toContain("hello there");
    expect(state.agents[0]?.status).toBe("working");
  });

  test("stream patches do not rebuild the compose textarea", () => {
    bootAgentChat();
    const field = app.querySelector(".agent-dock textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing compose");
    field.value = "keep me";
    field.dispatchEvent(new happy.Event("input", { bubbles: true }));
    expect(patchAgentChat({ follow: true })).toBe(true);
    expect(app.querySelector(".agent-dock textarea")).toBe(field);
    expect(field.value).toBe("keep me");
  });

  test("composer enforces the 32 KiB wire limit for multibyte text", () => {
    bootAgentChat();
    const field = app.querySelector(".agent-dock textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing compose");
    field.value = "会".repeat(32_768);
    field.dispatchEvent(new happy.Event("input", { bubbles: true }));
    expect(new TextEncoder().encode(state.composeDraft).length).toBeLessThanOrEqual(32_768);
    expect(field.value).toBe(state.composeDraft);
    expect(app.querySelector(".agent-compose-hint")?.textContent).toContain("32 KiB");
    expect(app.querySelector<HTMLElement>(".agent-compose-hint")?.hidden).toBe(false);
  });

  test("an oversized trace read keeps the current chat instead of claiming the prompt was not sent", async () => {
    bootAgentChat();
    state.live = {
      ...live(),
      agentTrace: async () => { throw new ProtocolError("too_large", "response exceeds protocol limit"); },
    } as typeof state.live;
    await refreshAgentTrace();
    const notice = app.querySelector(".agent-dock [data-app-notice]");
    expect(notice?.textContent).toContain("没能完整读取");
    expect(app.querySelector(".agent-stream [data-app-notice]")).toBeNull();
    expect(app.textContent).not.toContain("没有发送");
    expect(app.textContent).toContain("looks fine");
    expect(patchAgentChat({ follow: true })).toBe(true);
    expect(app.querySelector(".agent-dock [data-app-notice]")).toBe(notice);
  });

  test("blocked agents get a way back to the guided confirm UI", () => {
    bootAgentChat();
    state.agents[0].status = "blocked";
    renderPane();
    expect(app.querySelector(".agent-stream .agent-confirm")).toBeNull();
    expect(app.querySelector(".agent-confirm")?.textContent).toContain("等你确认");
    const go = app.querySelector(".agent-confirm button");
    if (!(go instanceof HTMLButtonElement)) throw new Error("missing 去确认");
    go.click();
    expect(state.agentChat).toBe(false);
    expect(paneTermMode("p1")).toBe("guided");
  });

  test("a failed empty read offers retry in the centered empty state", async () => {
    bootAgentChat();
    state.agents[0].status = "idle";
    state.agentTraceItems = [];
    state.agentTraceLoadState = "cold";
    state.agentTraceSig = "";
    state.live = {
      ...live(),
      agentTrace: async () => { throw new ProtocolError("internal", "boom"); },
    } as typeof state.live;
    state.agentTraceBusy = false;
    await refreshAgentTrace();
    expect(app.querySelector(".agent-empty-error")).toBeTruthy();
    expect(app.querySelector(".agent-empty-error button")?.textContent).toBe("重试");
    expect(app.querySelector(".agent-dock [data-app-notice]")).toBeNull();
  });

  test("会话操作 omits terminal display actions in 对话", () => {
    bootAgentChat();
    click('button[aria-label="会话操作"]');
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.textContent).toContain("模式");
    expect(sheet?.textContent).not.toContain("文字加大");
    expect(sheet?.textContent).not.toContain("复制画面文本");
    expect(sheet?.textContent).not.toContain("更早的输出");
    expect(sheet?.textContent).not.toContain("选择文本");
    expect(sheet?.textContent).not.toContain("长行自动折行");
    sheet?.remove();
  });

  test("new turns while scrolled up offer ↓ 新回复", () => {
    bootAgentChat();
    state.agentTraceFollow = false;
    state.agentTraceUnread = false;
    state.agentTraceItems = [...state.agentTraceItems, { type: "assistant", text: "later reply" }];
    expect(patchAgentChat({ follow: false })).toBe(true);
    const jump = app.querySelector(".agent-jump");
    if (!(jump instanceof HTMLButtonElement)) throw new Error("missing 新回复");
    expect(jump.hidden).toBe(false);
    expect(jump.textContent).toContain("新回复");
    jump.click();
    expect(state.agentTraceFollow).toBe(true);
    expect(state.agentTraceUnread).toBe(false);
    expect(jump.hidden).toBe(true);
  });
});
