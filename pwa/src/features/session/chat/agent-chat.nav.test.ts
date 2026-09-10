import { happy, resetChatDOM } from "../../../../test-support/chat-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { ProtocolError } from "../../../lib/protocol/errors";
import type { LiveSession } from "../../../lib/protocol/client";
import type { SnapshotWire } from "../../../lib/dashboard";

const { applyTrace, chatSnapshot } = await import("./trace-store.ts");
const { appRoot } = await import("../../../app/dom-root.ts");
const { commitView } = await import("../../../app/host.ts");
const { mountApp, unmountApp } = await import("../../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../../app/frame.ts");
const { registerSessionView } = await import("../register.ts");
const { resetTransitionState } = await import("../../../app/transition.ts");
const { clearAgentTraceCache } = await import("../../../lib/agent-trace-cache.ts");
const { goBackFromPane } = await import("../pane-actions.ts");
const { leaveAgentChat, patchAgentChat, refreshAgentTrace, restoreAgentTrace } = await import("./agent-chat-controller.ts");
const { resetComposeDrafts } = await import("../drafts/compose-drafts.ts");
const { setLang } = await import("../../../lib/i18n.ts");
const { setPhase } = await import("../../connection/connection-store.ts");
const { setScreen, currentScreen } = await import("../../../app/navigation-store.ts");
const { selectPane, openPaneId, setAgentChat, isAgentChat, resetPaneView, setFullTerminal } = await import("../session-store.ts");
const { applyCapabilities } = await import("../../operations/capabilities-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot, selectedAgent } = await import("../../dashboard/catalog-store.ts");
const { paneTermMode, setPaneTermMode, resetPreferences } = await import("../../settings/preferences-store.ts");
const { composeDraft, setComposeDraft, resetComposeField } = await import("../compose-store.ts");
const { clearNotice } = await import("../../../app/notices-store.ts");
import { happy as happyDom } from "../../../../test-support/dom";

const app = appRoot();

const SEED_ITEMS = [
  { type: "user" as const, text: "inspect this" },
  { type: "thinking" as const, text: "I will read it" },
  { type: "tool" as const, name: "Read", input: "{\"path\":\"a.ts\"}", output: "ok" },
  { type: "assistant" as const, text: "looks fine" },
];

function live(): LiveSession {
  return {
    agentTrace: async () => ({
      items: SEED_ITEMS.map((item) => ({ ...item })),
      nextCursor: null,
      truncated: false,
    }),
    agentTraceDetail: async (_paneId: string, detailRef: string) => ({ detailRef, input: "{}", output: "ok", truncated: false }),
    promptAgent: async () => ({ operation_id: "op_AAECAwQFBgcICQoL", pane_id: "p1", agent_status: "working", outcome: "applied" }),
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  } as unknown as LiveSession;
}

// Typed accessors replacing the legacy state facade in the test bodies.
const trace = () => chatSnapshot();
const setTrace = (patch: Parameters<typeof applyTrace>[0]): void => { applyTrace(patch); };
const setLive = (handle: LiveSession | null): void => { attachLiveSession(handle); };
// A seeded agent row as the tests build it (camelCase, like the old facade card).
type SeedAgent = {
  paneId?: string;
  agent?: string;
  hasAgent?: boolean;
  status?: string;
  cwd?: string;
  historyAvailable?: boolean;
};
const setAgents = (agents: ReadonlyArray<SeedAgent>, cwd = "/tmp/demo"): void => {
  const snapshot: SnapshotWire = {
    workspaces: [{ workspace_id: "w1", label: "demo", cwd }],
    panes: agents.map((a) => ({
      pane_id: a.paneId ?? "p1",
      workspace_id: "w1",
      agent: a.hasAgent === false || a.agent === "" ? "" : (a.agent ?? "codex"),
      agent_status: a.status ?? "working",
      cwd: a.cwd ?? cwd,
      history_available: a.historyAvailable ?? true,
    })),
  };
  applySnapshot(snapshot);
};

function paintPane(): void {
  commitView();
}

function bootAgentChat(draft = ""): void {
  act(() => {
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    resetPaneView();
    setFullTerminal(false);
    setAgentChat(true);
    setComposeDraft(draft);
    applyCapabilities({ prompt_agent: true, history: true }, []);
    setLive(live());
    setAgents([{
      paneId: "p1",
      agent: "codex",
      hasAgent: true,
      status: "working",
      cwd: "/tmp/demo",
      historyAvailable: true,
    }]);
    setTrace({
      agentTraceLoadState: "ready",
      agentTraceItems: SEED_ITEMS.map((item) => ({ ...item })),
      agentTraceTail: SEED_ITEMS.length,
      agentTraceSig: "seed",
      agentTraceTruncated: false,
      agentTracePending: "",
      agentTracePendingBase: [],
      agentTraceFollow: true,
      agentTraceUnread: false,
    });
    setPaneTermMode("p1", "agent");
    commitView();
  });
}

function click(selector: string): void {
  const el = app.querySelector(selector);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${selector}: ${app.innerHTML.slice(0, 280)}`);
  el.click();
}

// Re-point the navigation to a pane's chat view (typed domain actions + commit).
// Reads the saved per-pane term mode (it does NOT write a preference); callers
// that must force agent mode (the stale-p2 owner switch) pass agent=true after
// explicitly setting the pane term mode.
function showChatPane(paneId: string, agent = paneTermMode(paneId) === "agent"): void {
  setScreen("pane");
  selectPane(paneId);
  setAgentChat(agent);
  commitView();
}

beforeEach(async () => {
  await resetChatDOM();
  resetTransitionState();
  clearAgentTraceCache();
  resetComposeDrafts();
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});

afterEach(async () => await act(async () => {
  closeTestDialogs();
  // Drop any in-flight trace read and reset the chat view synchronously, then
  // let leaked read/detail continuations settle before unmount so they cannot
  // hold busy or publish into the next test's mount.
  clearAgentTraceCache();
  setTrace({
    agentTraceItems: [],
    agentTraceLoadState: "cold",
    agentTraceSig: "",
    agentTraceTail: 0,
    agentTracePending: "",
    agentTracePendingBase: [],
    agentTraceNext: null,
    agentTraceFollow: true,
    agentTraceBusy: false,
    agentTraceNote: "",
    agentTraceTruncated: false,
  });
  // The original teardown reset the pinned notice; a leaked copy/completion
  // notice would otherwise persist into the next mount.
  clearNotice();
  attachLiveSession(null);
  setAgentChat(false);
  setFullTerminal(false);
  selectPane("");
  setScreen("home");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  unmountApp();
  // Restore the named data baselines (compose field, draft store, per-pane
  // preferences) after the App unmounts; the original afterEach cleared the
  // draft and paneTermModes. These reset data only — the subscriber registry
  // stays intact for the next mount.
  resetComposeField();
  resetComposeDrafts();
  resetPreferences();
  registerSessionOwnerPreparer(null);
  resetTransitionState();
  await happyDom.happyDOM.abort();
}));

test("a restored multiline draft is measured after its chat field is mounted", async () => await act(async () => {
  const prototype = happy.HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
  Object.defineProperty(prototype, "scrollHeight", {
    configurable: true,
    get() { return this.isConnected ? 96 : 0; },
  });
  try {
    bootAgentChat("first line\nsecond line\nthird line");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const field = app.querySelector<HTMLTextAreaElement>(".agent-dock textarea")!;
    expect(field.value).toBe(composeDraft());
    expect(field.style.height).toBe("96px");
  } finally {
    if (descriptor) Object.defineProperty(prototype, "scrollHeight", descriptor);
    else delete (prototype as unknown as Record<string, unknown>).scrollHeight;
  }
}));

test.each([true, false])("growing the chat composer preserves follow=%s", async (following) => await act(async () => {
  bootAgentChat();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const stream = app.querySelector<HTMLElement>(".agent-stream")!;
  const field = app.querySelector<HTMLTextAreaElement>(".agent-dock textarea")!;
  Object.defineProperty(stream, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(field, "scrollHeight", { configurable: true, value: 96 });
  stream.scrollTop = 80;
  setTrace({ agentTraceFollow: following });
  field.value = "first line\nsecond line\nthird line";
  field.dispatchEvent(new happy.Event("input", { bubbles: true }));
  expect(field.style.height).toBe("96px");
  expect(stream.scrollTop).toBe(following ? 1000 : 80);
}));

describe("agent-chat remembers its mode per pane", () => {
  test("renders thinking, tools, and the final reply", async () => await act(async () => {
    bootAgentChat();
    expect(app.querySelector(".agent-chat-root")).toBeTruthy();
    expect(app.querySelector(".agent-process")).toBeTruthy();
    expect(app.querySelector(".agent-thinking")).toBeTruthy();
    expect(app.querySelector(".agent-thinking-preview")?.textContent).toBe("I will read it");
    expect(app.querySelector(".agent-tool")).toBeTruthy();
    expect(app.querySelector(".agent-assistant")?.textContent).toContain("looks fine");
    expect(app.querySelector(".agent-user")?.textContent).toContain("inspect this");
    expect(app.querySelector(".agent-user-role")).toBeNull();
    expect(app.querySelector(".agent-user-text")?.textContent).toBe("inspect this");
    expect(app.querySelector(".agent-process-summary")?.textContent).toContain("正在执行");
    expect(app.querySelector(".agent-stream-inner")).toBeTruthy();
    const title = app.querySelector(".agent-chat-root .chrome-title");
    expect(title).toBeTruthy();
    expect(title?.getAttribute("aria-label") || "").toContain("切换会话");
    if (!(title instanceof HTMLButtonElement)) throw new Error("title is not a button");
    title.click();
    expect(document.querySelector("dialog.sheet .modal-title")?.textContent).toBe("切换会话");
    closeTestDialogs();
  }));

  test("a cold working conversation shows loading instead of the empty call to action", async () => await act(async () => {
    bootAgentChat();
    let finish: ((page: Awaited<ReturnType<ReturnType<typeof live>["agentTrace"]>>) => void) | undefined;
    setTrace({ agentTraceItems: [] });
    setTrace({ agentTraceLoadState: "cold" });
    setTrace({ agentTraceSig: "" });
    setLive({
      ...live(),
      agentTrace: () => new Promise((resolve) => { finish = resolve; }),
    });

    paintPane();
    expect(app.querySelector(".agent-empty-working .agent-empty-title")?.textContent).toBe("正在执行");
    expect(app.querySelector(".agent-empty .spinner")).toBeTruthy();
    expect(app.textContent).not.toContain("还没有对话");

    await new Promise<void>(resolve => setTimeout(resolve, 0));
    finish?.({ items: [], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.querySelector(".agent-empty-working")).toBeTruthy();
    expect(app.textContent).not.toContain("还没有对话");
  }));

  test("a cold idle conversation uses loading and only shows the empty action after success", async () => await act(async () => {
    bootAgentChat();
    let finish: ((page: { items: []; nextCursor: null; truncated: false }) => void) | undefined;
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "idle" }]);
    setTrace({ agentTraceItems: [] });
    setTrace({ agentTraceLoadState: "cold" });
    setTrace({ agentTraceSig: "" });
    setLive({
      ...live(),
      agentTrace: () => new Promise((resolve) => { finish = resolve; }),
    });

    paintPane();
    expect(app.querySelector(".agent-empty-loading")).toBeTruthy();
    expect(app.querySelector(".agent-empty-title")?.textContent).toBe("正在读取执行过程");
    expect(app.querySelector(".agent-empty .spinner")).toBeTruthy();
    expect(app.textContent).not.toContain("还没有对话");
    expect(app.querySelector(".agent-stream")?.getAttribute("aria-busy")).toBe("true");

    await new Promise<void>(resolve => setTimeout(resolve, 0));
    finish?.({ items: [], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.querySelector(".agent-empty-empty .agent-empty-title")?.textContent).toBe("还没有对话");
    expect(app.querySelector(".agent-empty-sub")?.textContent).toContain("在下面");
    expect(app.querySelector(".agent-stream")?.getAttribute("aria-busy")).toBe("false");
  }));

  test("returning to a pane paints its last successful trace before refreshing", async () => await act(async () => {
    bootAgentChat();
    await refreshAgentTrace();
    goBackFromPane();
    showChatPane("p1");
    expect(restoreAgentTrace("p1")).toBe(true);
    paintPane();
    expect(app.textContent).toContain("looks fine");
    expect(app.textContent).not.toContain("还没有对话");
  }));

  test("the newest page paints before background context pagination finishes", async () => await act(async () => {
    bootAgentChat();
    let finishOlder: ((page: { items: Array<{ type: "user"; text: string }>; nextCursor: null; truncated: false }) => void) | undefined;
    setTrace({ agentTraceItems: [] });
    setTrace({ agentTraceLoadState: "cold" });
    setTrace({ agentTraceSig: "" });
    setLive({
      ...live(),
      agentTrace: async (_paneId: string, cursor: string | null) => {
        if (!cursor) return { items: [{ type: "assistant" as const, text: "newest reply" }], nextCursor: "older-1", truncated: false };
        return new Promise((resolve) => { finishOlder = resolve; });
      },
    });

    paintPane();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
    expect(app.textContent).toContain("newest reply");
    expect(trace().agentTraceBusy).toBe(true);

    finishOlder?.({ items: [{ type: "user", text: "owning prompt" }], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.textContent).toContain("owning prompt");
  }));

  test("deduplicates a repeated page-context user without losing older steps on refresh", async () => await act(async () => {
    bootAgentChat();
    let latestOutput = "latest-old";
    setTrace({ agentTraceItems: [] });
    setTrace({ agentTraceTail: 0 });
    setTrace({ agentTraceLoadState: "cold" });
    setTrace({ agentTraceSig: "" });
    setLive({
      ...live(),
      agentTrace: async (_paneId: string, cursor: string | null) => cursor
        ? {
            items: [
              { type: "user" as const, text: "owning prompt" },
              { type: "tool" as const, name: "Early", output: "early" },
            ],
            nextCursor: null,
            truncated: false,
          }
        : {
            items: [
              { type: "user" as const, text: "owning prompt" },
              { type: "tool" as const, name: "Latest", output: latestOutput },
            ],
            nextCursor: "older-1",
            truncated: false,
          },
    });

    await refreshAgentTrace();
    await refreshAgentTrace(true);
    expect(trace().agentTraceItems.filter((item) => item.type === "user")).toHaveLength(1);
    expect(trace().agentTraceItems.map((item) => item.name || item.text)).toEqual(["owning prompt", "Early", "Latest"]);

    latestOutput = "latest-new";
    await refreshAgentTrace();
    expect(trace().agentTraceItems.map((item) => item.name || item.text)).toEqual(["owning prompt", "Early", "Latest"]);
    expect(trace().agentTraceItems.at(-1)?.output).toBe("latest-new");
  }));

  test("a stale pane request cannot replace or unlock the current conversation", async () => await act(async () => {
    bootAgentChat();
    let finishP1: ((page: { items: Array<{ type: "assistant"; text: string }>; nextCursor: null; truncated: false }) => void) | undefined;
    let finishP2: ((page: { items: Array<{ type: "assistant"; text: string }>; nextCursor: null; truncated: false }) => void) | undefined;
    const session = {
      ...live(),
      agentTrace: (paneId: string) => new Promise((resolve) => {
        if (paneId === "p1") finishP1 = resolve;
        else finishP2 = resolve;
      }),
    } as unknown as LiveSession;
    setTrace({ agentTraceItems: [] });
    setTrace({ agentTraceLoadState: "cold" });
    setTrace({ agentTraceSig: "" });
    setLive(session);
    refreshAgentTrace();

    paintPane();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(trace().agentTraceBusy).toBe(true);

    leaveAgentChat({ rememberGuided: false, paint: false });
    setAgents([{ paneId: "p2", agent: "codex", status: "working" }]);
    // The stale-p2 case explicitly re-enters agent chat on p2 (original set
    // agentChat=true after the owner switch).
    setPaneTermMode("p2", "agent");
    showChatPane("p2", true);
    setTrace({ agentTraceItems: [] });
    setTrace({ agentTraceLoadState: "cold" });
    setTrace({ agentTraceSig: "" });
    refreshAgentTrace();
    paintPane();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(trace().agentTraceBusy).toBe(true);

    finishP1?.({ items: [{ type: "assistant", text: "stale p1 reply" }], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(trace().agentTraceBusy).toBe(true);
    expect(app.textContent).not.toContain("stale p1 reply");

    finishP2?.({ items: [{ type: "assistant", text: "current p2 reply" }], nextCursor: null, truncated: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(trace().agentTraceBusy).toBe(false);
    expect(app.textContent).toContain("current p2 reply");
  }));

  test("every turn stays in the stream, including earlier user messages", async () => await act(async () => {
    bootAgentChat();
    setTrace({ agentTraceItems: [
      { type: "user", text: "first question" },
      { type: "assistant", text: "first answer" },
      { type: "user", text: "inspect this" },
      { type: "thinking", text: "I will read it" },
      { type: "tool", name: "Read", input: "{\"path\":\"a.ts\"}", output: "ok" },
      { type: "assistant", text: "looks fine" },
    ] });
    expect(patchAgentChat({ follow: false })).toBe(true);
    const users = [...app.querySelectorAll(".agent-user-text")].map((el) => el.textContent);
    expect(users).toEqual(["first question", "inspect this"]);
    expect(app.querySelectorAll(".agent-assistant")).toHaveLength(2);
  }));

  test("keeps preamble, tool, and final reply in source order", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "idle" }]);
    setTrace({ agentTraceItems: [
      { type: "user", text: "inspect this" },
      { type: "assistant", text: "I will inspect it first." },
      { type: "tool", name: "Read", input: "{\"path\":\"a.ts\"}", output: "ok" },
      { type: "assistant", text: "Everything is fine." },
    ] });
    expect(patchAgentChat({ follow: true })).toBe(true);

    const fold = app.querySelector(".agent-reply-fold");
    const preamble = fold?.querySelector(".agent-assistant-intermediate");
    const tool = fold?.querySelector(".agent-tool");
    const final = app.querySelector(".agent-assistant-final");
    if (!(fold instanceof HTMLElement) || !(preamble instanceof HTMLElement) || !(tool instanceof HTMLElement) || !(final instanceof HTMLElement)) {
      throw new Error("missing chronological reply fold");
    }
    expect(preamble.textContent).toContain("I will inspect it first.");
    expect(tool.textContent).toContain("Read a.ts");
    expect(final.textContent).toContain("Everything is fine.");
    expect(Boolean(preamble.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(fold.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  }));

  test("anchors an optimistic prompt before output that arrives ahead of its transcript echo", async () => await act(async () => {
    bootAgentChat();
    setTrace({ agentTracePendingBase: trace().agentTraceItems.map((item) => ({ ...item })) });
    setTrace({ agentTracePending: "new question" });
    setTrace({ agentTraceItems: [...trace().agentTraceItems, { type: "thinking", text: "new work already arrived" }] });
    expect(patchAgentChat({ follow: true })).toBe(true);

    const pending = [...app.querySelectorAll<HTMLElement>(".agent-user")].at(-1);
    const work = [...app.querySelectorAll<HTMLElement>(".agent-thinking")].at(-1);
    if (!pending || !work) throw new Error("missing optimistic turn");
    expect(pending.textContent).toContain("new question");
    expect(work.textContent).toContain("思考");
    expect(Boolean(pending.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  }));

  test("shows explicit running, completed, and failed tool states", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "idle" }]);
    setTrace({ agentTraceItems: [
      { type: "user", text: "run tools" },
      { type: "tool", name: "First" },
      { type: "tool", name: "Second", output: "ok" },
      { type: "tool", name: "Third", output: "失败" },
    ] });
    expect(patchAgentChat({ follow: true })).toBe(true);
    expect([...app.querySelectorAll(".agent-tool-state")].map((item) => item.getAttribute("aria-label"))).toEqual([
      "执行中",
      "完成",
      "失败",
    ]);
  }));

  test("loads tool bodies only after expansion and reuses the loaded detail", async () => await act(async () => {
    bootAgentChat();
    let reads = 0;
    let finish: ((detail: { detailRef: string; input: string; output: string; truncated: true }) => void) | undefined;
    setTrace({ agentTraceItems: [
      { type: "user", text: "inspect" },
      { type: "tool", name: "Read", toolState: "done", detailRef: "detail-1" },
    ] });
    setLive({
      ...live(),
      agentTraceDetail: (_paneId: string, _detailRef: string) => {
        reads += 1;
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    expect(patchAgentChat({ follow: true })).toBe(true);
    expect(reads).toBe(0);
    expect(app.textContent).not.toContain("/secret/a.ts");

    const tool = app.querySelector(".agent-tool");
    if (!(tool instanceof HTMLDetailsElement)) throw new Error("missing lazy tool card");
    tool.open = true;
    tool.dispatchEvent(new happy.Event("toggle"));
    expect(reads).toBe(1);
    expect(app.textContent).toContain("正在加载详情");

    finish?.({ detailRef: "detail-1", input: '{"path":"/secret/a.ts"}', output: "private body", truncated: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(app.textContent).toContain("/secret/a.ts");
    expect(app.textContent).toContain("private body");
    expect(app.querySelector(".agent-tool .agent-detail-limit")?.textContent).toContain("部分较长内容已省略");
    expect(app.querySelector(".agent-trace-limit")).toBeNull();

    const painted = app.querySelector(".agent-tool");
    if (!(painted instanceof HTMLDetailsElement)) throw new Error("missing repainted tool card");
    painted.open = false;
    painted.dispatchEvent(new happy.Event("toggle"));
    painted.open = true;
    painted.dispatchEvent(new happy.Event("toggle"));
    expect(reads).toBe(1);
  }));

  test("keeps a failed detail read inside the tool card and retries on demand", async () => await act(async () => {
    bootAgentChat();
    let reads = 0;
    setTrace({ agentTraceItems: [{ type: "tool", name: "Read", toolState: "done", detailRef: "detail-retry" }] });
    setLive({
      ...live(),
      agentTraceDetail: async (_paneId: string, detailRef: string) => {
        reads += 1;
        if (reads === 1) throw new ProtocolError("timeout", "detail timed out");
        return { detailRef, output: "loaded after retry", truncated: false };
      },
    });
    expect(patchAgentChat({ follow: true })).toBe(true);
    const tool = app.querySelector(".agent-tool");
    if (!(tool instanceof HTMLDetailsElement)) throw new Error("missing lazy tool card");
    tool.open = true;
    tool.dispatchEvent(new happy.Event("toggle"));
    await Promise.resolve();
    await Promise.resolve();
    expect(app.querySelector(".agent-detail-error")).toBeTruthy();
    expect(app.querySelector(".agent-chat-root > [data-app-notice]")).toBeNull();
    click(".agent-detail-retry");
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(2);
    expect(app.textContent).toContain("loaded after retry");
  }));

  test("copies only the completed final reply", async () => await act(async () => {
    let copied = "";
    Object.defineProperty(happy.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { copied = text; } },
    });
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "idle" }]);
    expect(patchAgentChat({ follow: true })).toBe(true);
    click(".agent-reply-copy");
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toBe("looks fine");
    expect(app.querySelector(".agent-chat-root > [data-app-notice]")?.textContent).toContain("已复制回答");
  }));

  test("older history sits in the stream so it scrolls away from the latest turn", async () => await act(async () => {
    bootAgentChat();
    expect(app.querySelector(".agent-chat-root > .agent-older")).toBeNull();
    expect(app.querySelector(".agent-stream-inner > .agent-older")?.hidden).toBe(true);
    setTrace({ agentTraceNext: "cursor-1" });
    expect(patchAgentChat({ follow: false })).toBe(true);
    const older = app.querySelector(".agent-stream-inner > .agent-older");
    if (!(older instanceof HTMLButtonElement)) throw new Error("missing 加载更早内容");
    expect(older.hidden).toBe(false);
    expect(older.textContent).toBe("加载更早内容");
    expect(older.disabled).toBe(false);
    expect(older).toBe(app.querySelector(".agent-stream-inner")?.firstElementChild);
  }));

  test("‹ returns to the session list and keeps agent-chat as the pane mode", async () => await act(async () => {
    bootAgentChat();
    click(".chrome .back");
    expect(isAgentChat()).toBe(false);
    expect(currentScreen()).toBe("home");
    expect(paneTermMode("p1")).toBe("agent");
    expect(app.querySelector(".agent-chat-root")).toBeNull();
  }));

  test("reopening the pane restores agent-chat", async () => await act(async () => {
    bootAgentChat();
    click(".chrome .back");
    showChatPane("p1");
    expect(isAgentChat()).toBe(true);
    expect(app.querySelector(".agent-chat-root")).toBeTruthy();
    expect(app.querySelector(".dock")).toBeTruthy();
  }));

  test("退出对话 returns to the guided pane and remembers guided", async () => await act(async () => {
    bootAgentChat();
    leaveAgentChat();
    expect(isAgentChat()).toBe(false);
    expect(currentScreen()).toBe("pane");
    expect(paneTermMode("p1")).toBe("guided");
    expect(app.querySelector(".dock")).toBeTruthy();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
  }));

  test("swipe-back from agent-chat returns to the list", async () => await act(async () => {
    bootAgentChat();
    goBackFromPane();
    expect(currentScreen()).toBe("home");
    expect(paneTermMode("p1")).toBe("agent");
  }));

  test("Enter sends the draft and keeps the same compose field", async () => await act(async () => {
    bootAgentChat();
    const field = app.querySelector(".agent-dock textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing compose");
    field.value = "hello there";
    field.dispatchEvent(new happy.Event("input", { bubbles: true }));
    field.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(app.querySelector(".agent-dock textarea")).toBe(field);
    expect(composeDraft()).toBe("");
    expect(app.textContent).toContain("hello there");
    expect(app.querySelector(".agent-user-role")).toBeNull();
    expect([...app.querySelectorAll(".agent-user-text")].at(-1)?.textContent).toBe("hello there");
    expect(selectedAgent()?.status).toBe("working");
  }));

  test("stream patches do not rebuild the compose textarea", async () => await act(async () => {
    bootAgentChat();
    const field = app.querySelector(".agent-dock textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing compose");
    field.value = "keep me";
    field.dispatchEvent(new happy.Event("input", { bubbles: true }));
    expect(patchAgentChat({ follow: true })).toBe(true);
    expect(app.querySelector(".agent-dock textarea")).toBe(field);
    expect(field.value).toBe("keep me");
  }));

  test("renders trace clipping as a quiet stream note instead of a pinned global notice", async () => {
    bootAgentChat();
    setLive({
      ...live(),
      agentTrace: async () => ({ ...(await live().agentTrace()), truncated: true }),
    });
    await act(async () => { await refreshAgentTrace(); });

    const limit = app.querySelector(".agent-stream-inner > .agent-trace-limit");
    expect(limit?.textContent).toBe("部分较长内容已省略");
    expect(app.querySelector(".agent-chat-root > [data-app-notice]")).toBeNull();
    expect(trace().agentTraceNote).toBe("");

    setLive(live());
    await act(async () => { await refreshAgentTrace(); });
    expect(app.querySelector(".agent-trace-limit")).toBeNull();
  });

  test("composer enforces the 32 KiB wire limit for multibyte text", async () => await act(async () => {
    bootAgentChat();
    const field = app.querySelector(".agent-dock textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing compose");
    field.value = "会".repeat(32_768);
    field.dispatchEvent(new happy.Event("input", { bubbles: true }));
    expect(new TextEncoder().encode(composeDraft()).length).toBeLessThanOrEqual(32_768);
    expect(field.value).toBe(composeDraft());
    expect(app.querySelector(".agent-compose-hint")?.textContent).toContain("32 KiB");
    expect(app.querySelector<HTMLElement>(".agent-compose-hint")?.hidden).toBe(false);
  }));

  test("an oversized trace read keeps the current chat instead of claiming the prompt was not sent", async () => await act(async () => {
    bootAgentChat();
    setLive({
      ...live(),
      agentTrace: async () => { throw new ProtocolError("too_large", "response exceeds protocol limit"); },
    });
    await refreshAgentTrace();
    const notice = app.querySelector(".agent-chat-root > [data-app-notice]");
    expect(notice?.textContent).toContain("没能完整读取");
    expect(app.querySelector(".agent-dock [data-app-notice]")).toBeNull();
    expect(app.querySelector(".agent-stream [data-app-notice]")).toBeNull();
    expect(app.textContent).not.toContain("没有发送");
    expect(app.textContent).toContain("looks fine");
    expect(patchAgentChat({ follow: true })).toBe(true);
    expect(app.querySelector(".agent-chat-root > [data-app-notice]")).toBe(notice);
  }));

  test("blocked agents get a way back to the guided confirm UI", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "blocked" }]);
    paintPane();
    expect(app.querySelector(".agent-stream .agent-confirm")).toBeNull();
    expect(app.querySelector(".agent-confirm")?.textContent).toContain("等你确认");
    const go = app.querySelector(".agent-confirm button");
    if (!(go instanceof HTMLButtonElement)) throw new Error("missing 去确认");
    go.click();
    expect(isAgentChat()).toBe(false);
    expect(paneTermMode("p1")).toBe("guided");
  }));

  test("unknown agents do not show the confirm bar", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "unknown" }]);
    paintPane();
    expect(app.querySelector(".agent-confirm")).toBeNull();
    expect(app.textContent).not.toContain("等你确认");
    expect(app.querySelector(".chrome-meta-text")?.textContent).toBe("未知");
    expect(app.querySelector(".agent-unknown")).not.toBeNull();
    expect(app.querySelector(".icon-stop")).toBeNull();
  }));

  test("a failed empty read offers retry in the centered empty state", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "idle" }]);
    setTrace({ agentTraceItems: [] });
    setTrace({ agentTraceLoadState: "cold" });
    setTrace({ agentTraceSig: "" });
    setLive({
      ...live(),
      agentTrace: async () => { throw new ProtocolError("internal", "boom"); },
    });
    setTrace({ agentTraceBusy: false });
    await refreshAgentTrace();
    expect(app.querySelector(".agent-empty-error")).toBeTruthy();
    expect(app.querySelector(".agent-empty-error button")?.textContent).toBe("重试");
    expect(app.querySelector(".agent-dock [data-app-notice]")).toBeNull();
  }));

  test("会话操作 omits terminal display actions in 对话", async () => await act(async () => {
    bootAgentChat();
    click('button[aria-label="会话操作"]');
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.textContent).toContain("模式");
    expect(sheet?.textContent).not.toContain("文字加大");
    expect(sheet?.textContent).not.toContain("复制画面文本");
    expect(sheet?.textContent).not.toContain("更早的输出");
    expect(sheet?.textContent).not.toContain("选择文本");
    expect(sheet?.textContent).not.toContain("长行自动折行");
    closeTestDialogs();
  }));

  test("new turns while scrolled up offer ↓ 新回复", async () => await act(async () => {
    bootAgentChat();
    applyTrace({
      agentTraceFollow: false,
      agentTraceUnread: false,
      agentTraceItems: [...trace().agentTraceItems, { type: "assistant", text: "later reply" }],
    });
    expect(patchAgentChat({ follow: false })).toBe(true);
    const jump = app.querySelector(".agent-jump");
    if (!(jump instanceof HTMLButtonElement)) throw new Error("missing 新回复");
    expect(jump.hidden).toBe(false);
    expect(jump.textContent).toContain("新回复");
    jump.click();
    expect(trace().agentTraceFollow).toBe(true);
    expect(trace().agentTraceUnread).toBe(false);
    expect(jump.hidden).toBe(true);
  }));
});
