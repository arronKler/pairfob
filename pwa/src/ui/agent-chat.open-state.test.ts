import { happy, resetChatDOM } from "../../test-support/chat-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

const { state, app } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { patchAgentChat } = await import("./agent-chat.ts");
const { renderPane } = await import("./pane.ts");

const { leaveReactScreen } = await import("./react/root");
beforeEach(resetChatDOM);

const SEED_ITEMS = [
  { type: "user" as const, text: "inspect this" },
  { type: "thinking" as const, text: "I will read it" },
  { type: "tool" as const, name: "Read", input: '{"path":"a.ts"}', output: "ok" },
  { type: "assistant" as const, text: "looks **fine**" },
];

function bootIdleChat(): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.composeDraft = "";
  state.operationCapabilities = { ...state.operationCapabilities, history: true, prompt_agent: true };
  state.agents = [
    { paneId: "p1", agent: "codex", hasAgent: true, status: "idle", workspaceLabel: "demo", cwd: "/tmp/demo", historyAvailable: true },
  ];
  state.live = { isConnected: () => true };
  state.fullTerminal = false;
  state.agentChat = true;
  state.agentTraceItems = SEED_ITEMS.map((item) => ({ ...item }));
  state.agentTraceTail = SEED_ITEMS.length;
  state.agentTraceSig = "seed";
  state.agentTraceLoadState = "ready";
  state.agentTracePending = "";
  state.agentTracePendingBase = [];
  state.agentTraceFollow = true;
  setRenderer(() => renderPane());
  renderPane();
}

/**
 * Loading older trace pages prepends items, which shifts every positional
 * index. Step identity must come from content, or each prepend collapses the
 * cards the reader had expanded.
 */
describe("agent-chat keeps expanded steps while older pages load", () => {
  test("an open tool card survives prepended history", async () => await act(async () => {
    bootIdleChat();
    const tool = app.querySelector("details.agent-tool");
    if (!(tool instanceof happy.HTMLDetailsElement)) throw new Error("missing tool card");
    tool.open = true;
    expect(app.querySelector("details.agent-tool")?.hasAttribute("open")).toBe(true);

    state.agentTraceItems = [
      { type: "user", text: "older question" },
      { type: "assistant", text: "older answer" },
      ...state.agentTraceItems,
    ];
    expect(patchAgentChat({ older: true, top: 0, height: 40 })).toBe(true);

    const next = app.querySelector("details.agent-tool");
    if (!(next instanceof happy.HTMLDetailsElement)) throw new Error("tool card vanished");
    expect(next.open).toBe(true);
  }));

  test("a finished turn collapses the run and keeps the markdown reply visible", async () => await act(async () => {
    bootIdleChat();
    const process = app.querySelector("details.agent-process");
    if (!(process instanceof happy.HTMLDetailsElement)) throw new Error("missing process");
    expect(process.open).toBe(false);
    expect(process.textContent).toContain("执行过程");
    expect(app.querySelector(".agent-md strong")?.textContent).toBe("fine");
  }));

  test("the in-flight turn stays open until the agent is idle", async () => await act(async () => {
    bootIdleChat();
    state.agents[0].status = "working";
    expect(patchAgentChat({ follow: true })).toBe(true);
    const live = app.querySelector("details.agent-process");
    if (!(live instanceof happy.HTMLDetailsElement)) throw new Error("missing live process");
    expect(live.open).toBe(true);
    expect(live.querySelector(".agent-process-summary")?.textContent).toBe("正在执行");

    state.agents[0].status = "idle";
    expect(patchAgentChat({ follow: true })).toBe(true);
    const done = app.querySelector("details.agent-process");
    if (!(done instanceof happy.HTMLDetailsElement)) throw new Error("missing done process");
    expect(done.open).toBe(false);
    expect(app.querySelector(".agent-md strong")?.textContent).toBe("fine");
  }));
});

afterEach(async () => await act(async () => {
  state.agentChat = false;
  state.agentTraceItems = [];
  state.agentTraceLoadState = "cold";
  state.agentTraceSig = "";
  state.agentTraceTail = 0;
  state.agentTracePending = "";
  state.agentTracePendingBase = [];
  state.agentTraceNext = null;
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  leaveReactScreen();
  app.replaceChildren();
}));
