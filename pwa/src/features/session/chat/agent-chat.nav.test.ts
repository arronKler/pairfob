import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { expectSameNode } from "../../../../test-support/node-identity";
import {
  app, live, trace, setTrace, setLive, setAgents, paintPane, bootAgentChat, showChatPane,
  useAgentChatNavFixture,
} from "../../../../test-support/agent-chat-nav";

import { happy } from "../../../../test-support/chat-dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { click } from "../../../../test-support/agent-chat-nav";
import { ProtocolError } from "../../../lib/protocol/errors";
import { emulateTouchDevice } from "../touch-realm";
import { MOTION_MS } from "../../../shared/ui/dom/motion";
import { afterExit } from "../../../../test-support/exit";

const { applyTrace } = await import("./trace-store.ts");
const { goBackFromPane } = await import("../pane-actions.ts");
const { leaveAgentChat, patchAgentChat } = await import("./agent-chat-controller.ts");
const { setNetworkOnline } = await import("../../connection/connection-store.ts");
const { currentScreen } = await import("../../../app/navigation-store.ts");
const { isAgentChat } = await import("../session-store.ts");
const { selectedAgent } = await import("../../dashboard/catalog-store.ts");
const { paneTermMode } = await import("../../settings/preferences-store.ts");
const { composeDraft } = await import("../compose-store.ts");

useAgentChatNavFixture();

/** Set by a case that pins touch behaviour; the realm goes back to a mouse after it. */
let restorePointer: (() => void) | null = null;
afterEach(() => {
  restorePointer?.();
  restorePointer = null;
});

describe("agent-chat remembers its mode per pane", () => {
  test("renders thinking, tools, and the final reply", async () => await act(async () => {
    bootAgentChat();
    expect(app.querySelector(".agent-chat-root")).toBeTruthy();
    expect(app.querySelector(".work-card")).toBeTruthy();
    expect(app.querySelector(".work-step.is-think .work-step-text")?.textContent).toBe("I will read it");
    expect(app.querySelector(".work-step.is-read")).toBeTruthy();
    expect(app.querySelector(".agent-assistant")?.textContent).toContain("looks fine");
    expect(app.querySelector(".agent-user")?.textContent).toContain("inspect this");
    expect(app.querySelector(".agent-user-role")).toBeNull();
    expect(app.querySelector(".agent-user-text")?.textContent).toBe("inspect this");
    expect(app.querySelector(".work-card .work-head")?.getAttribute("aria-expanded")).toBe("true");
    expect(app.querySelector(".agent-stream-inner")).toBeTruthy();
    const title = app.querySelector(".agent-chat-root .chrome-title");
    expect(title).toBeTruthy();
    // The shared, display-only identity: no "switch session" affordance.
    expect(title?.tagName).toBe("DIV");
    expect(title?.querySelector(".chrome-avatar .agent-avatar")).toBeTruthy();
    (title as HTMLElement).click();
    expect(document.querySelector("dialog.sheet")).toBeNull();
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

  test("keeps a note, its tool, and the final reply in source order", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "idle" }]);
    setTrace({ agentTraceItems: [
      { type: "user", text: "inspect this" },
      { type: "assistant", text: "I will inspect it first." },
      { type: "tool", name: "Read", input: "{\"path\":\"a.ts\"}", output: "ok" },
      { type: "assistant", text: "Everything is fine." },
    ] });
    expect(patchAgentChat({ follow: true })).toBe(true);

    const fold = app.querySelector(".work-card");
    // The note is a row in the card, ahead of the tool it introduces.
    const note = fold?.querySelector(".work-step.is-note");
    const tool = fold?.querySelector(".work-step.is-read");
    const final = app.querySelector(".agent-assistant-final");
    if (!(fold instanceof HTMLElement) || !(note instanceof HTMLElement) || !(tool instanceof HTMLElement) || !(final instanceof HTMLElement)) {
      throw new Error("missing chronological step card");
    }
    expect(note.textContent).toContain("I will inspect it first.");
    expect(tool.textContent).toContain("Read a.ts");
    expect(final.textContent).toContain("Everything is fine.");
    // Source order holds inside the card, and the reply stays below it.
    expect(Boolean(note.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(fold.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  }));

  test("anchors an optimistic prompt before output that arrives ahead of its transcript echo", async () => await act(async () => {
    bootAgentChat();
    setTrace({ agentTracePendingBase: trace().agentTraceItems.map((item) => ({ ...item })) });
    setTrace({ agentTracePending: "new question" });
    setTrace({ agentTraceItems: [...trace().agentTraceItems, { type: "thinking", text: "new work already arrived" }] });
    expect(patchAgentChat({ follow: true })).toBe(true);

    const pending = [...app.querySelectorAll<HTMLElement>(".agent-user")].at(-1);
    const work = [...app.querySelectorAll<HTMLElement>(".work-step.is-think")].at(-1);
    if (!pending || !work) throw new Error("missing optimistic turn");
    expect(pending.textContent).toContain("new question");
    expect(work.textContent).toContain("new work already arrived");
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
    // Without trace_labels a finished step only "ended": success is not claimed.
    expect([...app.querySelectorAll(".work-step")].map((item) => item.className)).toEqual([
      "work-step is-other is-running",
      "work-step is-other is-ended",
      "work-step is-other is-error",
    ]);
  }));

  test("loads tool bodies only when the step sheet opens and reuses the loaded detail", async () => await act(async () => {
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
    expect(document.body.textContent).not.toContain("/secret/a.ts");

    click(".work-step.is-read");
    await Promise.resolve();
    expect(reads).toBe(1);
    const sheet = () => document.querySelector("dialog.step-sheet");
    expect(sheet()?.textContent).toContain("正在加载详情");

    finish?.({ detailRef: "detail-1", input: '{"path":"/secret/a.ts"}', output: "private body", truncated: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(sheet()?.textContent).toContain("/secret/a.ts");
    expect(sheet()?.textContent).toContain("private body");
    expect(sheet()?.querySelector(".step-note")).toBeTruthy();
    expect(app.querySelector(".agent-trace-limit")).toBeNull();

    closeTestDialogs();
    click(".work-step.is-read");
    await Promise.resolve();
    expect(reads).toBe(1);
    closeTestDialogs();
  }));

  test("keeps a failed detail read inside the step sheet and retries on demand", async () => await act(async () => {
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
    click(".work-step.is-read");
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    const sheet = () => document.querySelector("dialog.step-sheet");
    expect(sheet()?.querySelector(".agent-detail-error")).toBeTruthy();
    expect(app.querySelector(".agent-chat-root > [data-app-notice]")).toBeNull();
    sheet()?.querySelector<HTMLButtonElement>(".agent-detail-error button")?.click();
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    expect(reads).toBe(2);
    expect(sheet()?.textContent).toContain("loaded after retry");
    closeTestDialogs();
  }));

  test("copies only the completed final reply", async () => {
    let copied = "";
    Object.defineProperty(happy.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { copied = text; } },
    });
    await act(async () => {
      bootAgentChat();
      setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "idle" }]);
      expect(patchAgentChat({ follow: true })).toBe(true);
      click(".agent-reply-copy");
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    });
    expect(copied).toBe("looks fine");
    // Confirmed on the button: a banner above the transcript would move it under the next press.
    expect(app.querySelector(".agent-chat-root > [data-app-notice]")).toBeNull();
    const button = app.querySelector(".agent-reply-copy")!;
    expect([button.querySelector('.copy-ack-face[aria-hidden="false"]')?.textContent, button.getAttribute("aria-label"),
      button.querySelector(".copy-ack")?.getAttribute("data-state")]).toEqual(["已复制", "已复制回答", "copied"]);
  });

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
    expectSameNode(older, app.querySelector(".agent-stream-inner")?.firstElementChild);
  }));

  test("the header steps aside while the reader is away from the tail", async () => await act(async () => {
    bootAgentChat();
    const chrome = (): Element | null => app.querySelector(".agent-chrome");
    const inner = (): Element | null => app.querySelector(".agent-chrome-inner");
    const peek = (): HTMLButtonElement | null => app.querySelector(".agent-peek");

    // A fresh visit at the tail keeps the header in place and the peek out of reach.
    expect(chrome()?.getAttribute("data-collapsed")).toBeNull();
    expect(inner()?.hasAttribute("inert")).toBe(false);
    expect(peek()?.tabIndex).toBe(-1);
    expect(app.querySelector(".agent-chrome .chrome-title")).toBeTruthy();

    // Scrolled away: the header leaves the page, its controls leave the tab order.
    applyTrace({ agentTraceFollow: false });
    paintPane();
    expect(chrome()?.getAttribute("data-collapsed")).toBe("1");
    expect(inner()?.hasAttribute("inert")).toBe(true);
    expect(inner()?.getAttribute("aria-hidden")).toBe("true");
    expect(peek()?.tabIndex).toBe(0);
    expect(peek()?.getAttribute("aria-hidden")).toBeNull();
    expect(peek()?.getAttribute("aria-label")).toBe("显示会话标题");

    // The peek reveals it until the reader is back at the tail.
    peek()!.click();
    await Promise.resolve();
    expect(chrome()?.getAttribute("data-collapsed")).toBeNull();
    expect(inner()?.hasAttribute("inert")).toBe(false);
    expect(inner()?.getAttribute("aria-hidden")).toBeNull();
    expect(peek()?.tabIndex).toBe(-1);

    applyTrace({ agentTraceFollow: true });
    paintPane();
    expect(chrome()?.getAttribute("data-collapsed")).toBeNull();
    expect(inner()?.hasAttribute("inert")).toBe(false);

    // The tail clears the peek too: the next scroll away starts collapsed again.
    applyTrace({ agentTraceFollow: false });
    paintPane();
    expect(chrome()?.getAttribute("data-collapsed")).toBe("1");
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

  test("a phone's Return adds a line; the send button sends and keeps the same compose field", async () => await act(async () => {
    restorePointer = emulateTouchDevice();
    bootAgentChat();
    const field = app.querySelector(".agent-dock textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing compose");
    field.value = "hello there";
    field.dispatchEvent(new happy.Event("input", { bubbles: true }));
    const enter = new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    field.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(composeDraft()).toBe("hello there");
    app.querySelector<HTMLButtonElement>(".agent-dock .send-btn")!.click();
    await Promise.resolve();
    await Promise.resolve();
    expectSameNode(app.querySelector(".agent-dock textarea"), field);
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
    expectSameNode(app.querySelector(".agent-dock textarea"), field);
    expect(field.value).toBe("keep me");
  }));

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

  test("blocked agents get a way back to the guided confirm UI", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "blocked" }]);
    paintPane();
    // At the latest message the turn's own card is the way out; the dock entry
    // only appears for a reader scrolled away from it.
    expect(app.querySelector(".agent-stream .needs-card")).toBeTruthy();
    // Folded shut it is out of reach, not out of the page: it opens and shuts by height.
    const line = (): Element | null | undefined => app.querySelector(".agent-confirm")?.closest(".fold");
    expect([line()?.classList.contains("is-shut"), line()?.hasAttribute("inert")]).toEqual([true, true]);
    applyTrace({ agentTraceFollow: false });
    paintPane();
    expect([line()?.classList.contains("is-shut"), line()?.hasAttribute("inert")]).toEqual([false, false]);
    expect(app.querySelector(".agent-confirm")?.textContent).toContain("等你确认");
    const go = app.querySelector(".agent-confirm button");
    if (!(go instanceof HTMLButtonElement)) throw new Error("missing 去终端处理");
    expect(go.textContent).toBe("去终端处理");
    go.click();
    expect(isAgentChat()).toBe(false);
    expect(paneTermMode("p1")).toBe("guided");
  }));

  test("unknown agents do not show the confirm bar", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "unknown" }]);
    paintPane();
    expect(app.querySelector(".agent-confirm")?.closest(".fold")?.hasAttribute("inert")).toBe(true);
    expect(app.querySelector(".agent-stream")?.textContent).not.toContain("等你确认");
    expect(app.querySelector(".chrome-status")?.textContent).toBe("未知");
    expect(app.querySelector(".agent-avatar-status.is-unknown")).not.toBeNull();
    expect(app.querySelector(".icon-stop")).toBeNull();
  }));

  test("a working agent reads as unknown once contact is lost, not as still working", async () => await act(async () => {
    bootAgentChat();
    setAgents([{ ...(selectedAgent() ?? { paneId: "p1" }), status: "working" }]);
    setNetworkOnline(false);
    try {
      paintPane();
      expect(app.querySelector(".chrome-status")?.textContent).toBe("未知");
      expect(app.querySelector(".agent-avatar-status.is-unknown")).not.toBeNull();
      expect(app.querySelector(".agent-avatar-status.is-working")).toBeNull();
      expect(app.querySelector(".icon-stop")).toBeNull();
    } finally {
      setNetworkOnline(true);
    }
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

  test("new output while scrolled up offers the jump (新进展 while the agent works)", async () => {
    const jump = await act(async () => pressJump());
    // The chip leaves with the scroll it started, out of reach, and is then put away.
    expect(jump.classList.contains("term-jump-out")).toBe(true);
    expect(jump.inert).toBe(true);
    await afterExit(MOTION_MS.press);
    expect(jump.hidden).toBe(true);
  });

  function pressJump(): HTMLButtonElement {
    bootAgentChat();
    applyTrace({
      agentTraceFollow: false,
      agentTraceUnread: false,
      agentTraceItems: [...trace().agentTraceItems, { type: "assistant", text: "later reply" }],
    });
    expect(patchAgentChat({ follow: false })).toBe(true);
    const jump = app.querySelector(".agent-jump");
    if (!(jump instanceof HTMLButtonElement)) throw new Error("missing jump");
    expect(jump.hidden).toBe(false);
    expect(jump.textContent).toContain("有新进展");
    jump.click();
    expect(trace().agentTraceFollow).toBe(true);
    expect(trace().agentTraceUnread).toBe(false);
    return jump;
  }
});
