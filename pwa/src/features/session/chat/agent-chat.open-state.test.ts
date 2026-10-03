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
  test("an open step card survives prepended history", async () => await act(async () => {
    bootIdleChat();
    const card = app.querySelector("details.work-card");
    if (!(card instanceof happy.HTMLDetailsElement)) throw new Error("missing step card");
    card.open = true;
    expect(app.querySelector("details.work-card")?.hasAttribute("open")).toBe(true);

    applyTrace({
      agentTraceItems: [
        { type: "user", text: "older question" },
        { type: "assistant", text: "older answer" },
        ...SEED_ITEMS,
      ],
    });
    expect(patchAgentChat({ older: true, top: 0, height: 40 })).toBe(true);

    const next = app.querySelector("details.work-card");
    if (!(next instanceof happy.HTMLDetailsElement)) throw new Error("step card vanished");
    expect(next.open).toBe(true);
  }));

  test("a finished turn collapses its card and keeps the markdown reply visible", async () => await act(async () => {
    bootIdleChat();
    const card = app.querySelector("details.work-card");
    if (!(card instanceof happy.HTMLDetailsElement)) throw new Error("missing step card");
    expect(card.open).toBe(false);
    expect(card.querySelector(".work-title")?.textContent).toBeTruthy();
    expect(app.querySelector(".agent-md strong")?.textContent).toBe("fine");
  }));

  test("the in-flight turn stays open until the agent is idle", async () => await act(async () => {
    bootIdleChat();
    act(() => applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working" }],
    }));
    expect(patchAgentChat({ follow: true })).toBe(true);
    const live = app.querySelector("details.work-card");
    if (!(live instanceof happy.HTMLDetailsElement)) throw new Error("missing live card");
    expect(live.open).toBe(true);
    // Live, or unconfirmed when this harness has no connection; never done.
    expect(["work-card is-running", "work-card is-stale"]).toContain(live.className);

    act(() => applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }],
    }));
    expect(patchAgentChat({ follow: true })).toBe(true);
    const done = app.querySelector("details.work-card");
    if (!(done instanceof happy.HTMLDetailsElement)) throw new Error("missing done card");
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
