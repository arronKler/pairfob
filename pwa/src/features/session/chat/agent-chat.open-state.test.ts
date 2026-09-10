import { happy, resetChatDOM } from "../../../../test-support/chat-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { LiveSession } from "../../../lib/protocol/client";

const { applyTrace } = await import("./trace-store.ts");
const { appRoot } = await import("../../../app/dom-root.ts");
const { commitView } = await import("../../../app/host.ts");
const { mountApp, unmountApp } = await import("../../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../../app/frame.ts");
const { registerSessionView } = await import("../register.ts");
const { resetTransitionState } = await import("../../../app/transition.ts");
const { patchAgentChat } = await import("./agent-chat-controller.ts");
const { setPhase } = await import("../../connection/connection-store.ts");
const { setScreen } = await import("../../../app/navigation-store.ts");
const { resetPaneView, selectPane, setAgentChat, setFullTerminal } = await import("../session-store.ts");
const { applyCapabilities } = await import("../../operations/capabilities-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot } = await import("../../dashboard/catalog-store.ts");
import { happy as happyDom } from "../../../../test-support/dom";

const app = appRoot();

const SEED_ITEMS = [
  { type: "user" as const, text: "inspect this" },
  { type: "thinking" as const, text: "I will read it" },
  { type: "tool" as const, name: "Read", input: '{"path":"a.ts"}', output: "ok" },
  { type: "assistant" as const, text: "looks **fine**" },
];

function bootIdleChat(): void {
  act(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    resetPaneView();
    setFullTerminal(false);
    setAgentChat(true);
    applyCapabilities({ history: true, prompt_agent: true }, []);
    attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
    applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }],
    });
    applyTrace({
      agentTraceItems: SEED_ITEMS.map((item) => ({ ...item })),
      agentTraceTail: SEED_ITEMS.length,
      agentTraceSig: "seed",
      agentTraceLoadState: "ready",
      agentTracePending: "",
      agentTracePendingBase: [],
      agentTraceFollow: true,
    });
    commitView();
  });
}

beforeEach(async () => {
  await resetChatDOM();
  resetTransitionState();
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});

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

    applyTrace({
      agentTraceItems: [
        { type: "user", text: "older question" },
        { type: "assistant", text: "older answer" },
        ...SEED_ITEMS,
      ],
    });
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
    act(() => applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working" }],
    }));
    expect(patchAgentChat({ follow: true })).toBe(true);
    const live = app.querySelector("details.agent-process");
    if (!(live instanceof happy.HTMLDetailsElement)) throw new Error("missing live process");
    expect(live.open).toBe(true);
    expect(live.querySelector(".agent-process-summary")?.textContent).toBe("正在执行");

    act(() => applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }],
    }));
    expect(patchAgentChat({ follow: true })).toBe(true);
    const done = app.querySelector("details.agent-process");
    if (!(done instanceof happy.HTMLDetailsElement)) throw new Error("missing done process");
    expect(done.open).toBe(false);
    expect(app.querySelector(".agent-md strong")?.textContent).toBe("fine");
  }));
});

afterEach(async () => await act(async () => {
  applyTrace({
    agentTraceItems: [],
    agentTraceLoadState: "cold",
    agentTraceSig: "",
    agentTraceTail: 0,
    agentTracePending: "",
    agentTracePendingBase: [],
    agentTraceNext: null,
  });
  // Restore the pane/chat/screen baseline before the App unmounts.
  setAgentChat(false);
  setFullTerminal(false);
  selectPane("");
  setScreen("home");
  attachLiveSession(null);
  unmountApp();
  registerSessionOwnerPreparer(null);
  resetTransitionState();
  await happyDom.happyDOM.abort();
}));
