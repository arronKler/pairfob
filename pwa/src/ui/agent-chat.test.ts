import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./agent-chat.ts", import.meta.url)).text();
const pane = await Bun.file(new URL("./pane.ts", import.meta.url)).text();
const view = await Bun.file(new URL("./session/view.ts", import.meta.url)).text();
const desk = await Bun.file(new URL("./desk.ts", import.meta.url)).text();

function fn(name: string, next: string): string {
  const start = source.indexOf(name);
  const end = source.indexOf(next);
  expect(start, name).toBeGreaterThanOrEqual(0);
  expect(end, next).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("agent-chat is a first-class pane mode", () => {
  test("enter records the pane mode and does not use History", () => {
    const enter = fn("export function enterAgentChat(", "export function leaveAgentChat(");
    expect(enter).toContain('setPaneTermMode(state.paneId, "agent")');
    expect(source).not.toContain("session.history");
    expect(source).toContain("session.agentTrace");
    expect(source).toContain("session.promptAgent");
    expect(source).toContain("markPaneSubmitted");
  });

  test("typing stays in the same textarea while the stream patches", () => {
    expect(source).toContain("export function patchAgentChat(");
    expect(source).toContain("stream.replaceWith(next)");
    expect(source).toContain("readDetailsState(stream)");
    expect(source).toContain("painted.scrollTop = prevTop");
    expect(source).toContain("stream.dataset.sig === sig");
    expect(source).toContain('event.key !== "Enter" || event.shiftKey');
    expect(source).toContain('enterKeyHint = "send"');
    expect(source).toContain("agentTracePending");
  });

  test("turns collapse the run and render the reply as markdown", async () => {
    const paint = await Bun.file(new URL("./agent-chat-stream.ts", import.meta.url)).text();
    expect(paint).toContain('node("details", "agent-process")');
    expect(paint).toContain("markdownEl");
    expect(paint).toContain('t("chat.runningEllipsis")');
    expect(paint).toContain("agent-assistant");
    expect(paint).toContain("agent-stream-inner");
    expect(paint).toContain("agent-user-role");
    expect(paint).toContain("agent-empty");
    expect(paint).toContain("agent-empty-sub");
    expect(paint).not.toContain('"empty-sub"');
    expect(paint).not.toContain("agent-blocked");
    expect(source).toContain("agent-confirm");
    expect(source).toContain("syncChatDock");
    expect(source).toContain("paintChatNotice");
    expect(source).toContain("existing.classList.contains(`notice-${want.tone}`)");
    expect(source).toContain("agent-jump");
    expect(source).toContain("agentTraceUnread");
    expect(source).not.toContain("agent-bubble");
    expect(source).toContain('t("hist.loadEarlier")');
    expect(source).toContain('next.querySelector(".agent-stream-inner")?.prepend(olderButton())');
    expect(source).not.toContain("olderButton(), stream");
    expect(source).toContain("firstTurnNeedsUser");
    expect(source).toContain("TRACE_PAGE = 200");
  });

  test("leave paints guided itself; list-back keeps the mode", () => {
    const leave = fn("export function leaveAgentChat(", "function paintItems(");
    expect(leave).toContain('setPaneTermMode(state.paneId, "guided")');
    expect(pane).toContain("renderAgentChat(goBackFromPane, openPaneMenu, openPaneSwitcher)");
    const back = pane.slice(pane.indexOf("export function goBackFromPane("), pane.indexOf("export function sessionHandlers("));
    expect(back).toContain("if (state.agentChat)");
    expect(back).toContain("rememberGuided: false");
  });

  test("guided chrome and the desk main column both host the mode", () => {
    expect(view).not.toContain("handlers.onAgentChat");
    expect(desk).toContain("fillAgentChat");
    expect(desk).toContain("state.agentChat");
    expect(desk).toContain('node("div", "pane-root")');
    expect(desk).toContain("fillSession(pane, selected, false, handlers)");
    expect(desk).not.toContain("fillSession(main,");
  });

  test("live polling patches the chat instead of replacing the pane", async () => {
    const live = await Bun.file(new URL("../live.ts", import.meta.url)).text();
    expect(live).toContain("patchAgentChat");
    expect(live).toContain("const changed = await refreshAgentTrace()");
    expect(view).toContain("if (state.agentChat) return");
  });
});
