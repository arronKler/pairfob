import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "../react/root";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";

const { setLang } = await import("../../lib/i18n");
const { setRenderer } = await import("../../paint");
const { app, clearNotice, state } = await import("../../state");
const { noteSnapshot } = await import("./unread");
const { SessionTerminal } = await import("../react/session-terminal");

const termSource = await Bun.file(new URL("./term.ts", import.meta.url)).text();
const keysSource = await Bun.file(new URL("./keys.ts", import.meta.url)).text();
const liveSource = await Bun.file(new URL("../../live.ts", import.meta.url)).text();
const viewSource = await Bun.file(new URL("./view.ts", import.meta.url)).text();
const reactTerm = await Bun.file(new URL("../react/session-terminal.tsx", import.meta.url)).text();
const reactRail = await Bun.file(new URL("../react/session-scroll.tsx", import.meta.url)).text();

function body(name: string): string {
  const start = termSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const open = termSource.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < termSource.length; i += 1) {
    if (termSource[i] === "{") depth += 1;
    if (termSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return termSource.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

function paint(): void {
  act(() => renderReactScreen(createElement(SessionTerminal)));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  act(leaveReactScreen);
  app.replaceChildren();
  setLang("zh");
  setRenderer(() => {});
  Object.assign(state, {
    phase: "live", screen: "home", paneId: "", paneText: "", paneHash: "", live: null,
    agents: [], fullTerminal: false, agentChat: false, operationBusy: false,
    composeDraft: "", composeLive: false, composeIME: false, composeFocused: false,
    defaultComposeLive: false, paneComposeLive: {}, keysExpanded: false, padKind: "keys",
    termSelect: false, termWrap: false, paneRow: null, paneFollow: true, paneUnread: false,
  });
  clearNotice();
});

afterEach(() => {
  state.termSelect = false;
  state.paneFollow = true;
  state.paneUnread = false;
  state.paneText = "";
  act(leaveReactScreen);
  clearNotice();
  setRenderer(() => {});
  app.replaceChildren();
});

describe("terminal rows stay faithful to the live TUI", () => {
  test("the tap handler focuses input and never interprets terminal text", () => {
    const tap = body("bindTap");
    expect(tap).toContain("focusCompose()");
    expect(tap).toContain("HOLD_MS");
    expect(tap).not.toContain("answerPrompt");
    expect(tap).not.toContain("prompt-select");
  });

  test("a short tap types; a long press opens the row bar", () => {
    const tap = body("bindTap");
    expect(tap).toContain("focusCompose()");
    expect(tap).toContain("onRow(index)");
    expect(tap).toContain('"scroll"');
    expect(tap).toContain("panned");
  });

  test("the patch path that delivers the dialog does not repaint the pane", () => {
    expect(liveSource).toContain("patchSessionScreen()");
    expect(termSource).toContain("export function fillTerm");
    expect(termSource).toContain("notifyTermDisplay()");
    expect(termSource).not.toContain("termInner(term).replaceChildren");
  });

  test("paint mounts every screen row without inventing buttons or options", () => {
    state.phase = "live";
    state.screen = "pane";
    state.paneId = "p1";
    state.paneText = "hello\nworld";
    state.termSelect = false;
    paint();
    const rows = [...app.querySelectorAll(".term-line")];
    expect(rows.map((row) => row.getAttribute("data-row"))).toEqual(["0", "1"]);
    expect(rows[0]?.textContent).toContain("hello");
    expect(rows[1]?.textContent).toContain("world");
    expect(app.querySelector('.term-line[role="button"]')).toBeNull();
    expect(app.querySelector(".term-option")).toBeNull();
    expect(reactTerm).toContain("paintLines(model.lines)");
    expect(termSource).not.toContain("answerPrompt");
    expect(termSource).not.toContain("prompt-select");
    expect(termSource).not.toContain("function lineRow(");
  });

  test("paint drops computer-window padding before rows are mounted", () => {
    expect(reactTerm).toContain("paintLines(model.lines)");
    expect(reactTerm).toContain("displayedTermModel(paneModel())");
    expect(termSource).toContain("displayedTermModel(model)");
  });

  test("rows share a max-content canvas so short TUI bars match long lines", () => {
    state.paneText = "short\n" + "x".repeat(80);
    paint();
    const inner = app.querySelector(".term-inner");
    const term = app.querySelector(".term");
    expect(inner !== null).toBeTrue();
    expect(term?.contains(inner!)).toBeTrue();
    expect(reactTerm).toContain('className="term-inner"');
    expect(termSource).not.toContain("termInner(term).replaceChildren(frag)");
  });

  test("the live buffer is only the current viewport", () => {
    expect(termSource).not.toContain("term-more");
    expect(termSource).not.toContain("term-back");
    expect(termSource).not.toContain("fetchTerminalHistory");
    expect(termSource).not.toContain("revealOlder");
    expect(termSource).not.toContain("olderThanLive");
  });

  test("TUI wheel uses TerminalScroll while page buttons keep CSI", () => {
    state.paneText = "ready";
    paint();
    expect(app.querySelector(".full-terminal-scroll")).toBeTruthy();
    expect([...app.querySelectorAll(".full-terminal-scroll-btn")].map((el) => el.getAttribute("aria-label"))).toEqual([
      "鼠标滚轮向上",
      "上一页",
      "下一页",
      "鼠标滚轮向下",
    ]);
    expect(termSource).toContain("sendGuidedTuiScroll");
    expect(termSource).not.toContain('"pageup"');
    expect(termSource).not.toContain('"pagedown"');
    expect(termSource).toContain('source === "page_key"');
    expect(termSource).toContain("sendPage");
    expect(termSource).toContain("guidedScrollController.scroll");
    expect(termSource).toContain("direction, lines");
    expect(keysSource).toContain("\\u001b[5~");
    expect(keysSource).toContain("session.sendText");
    expect(reactTerm).toContain("sendGuidedTuiScroll(direction, lines, source)");
    expect(reactTerm).toContain("capturePan: guidedCapturePan");
    expect(reactTerm).toContain("SessionScrollRail");
    expect(reactRail).toContain('className="full-terminal-scroll"');
    expect(termSource).not.toContain("scrollRail(");
  });
});

describe("the buffer is a live PTY surface, not a fitted screenshot", () => {
  test("session paint does not auto-shrink the grid to the phone width", () => {
    expect(viewSource).not.toContain("syncTermWidthFit");
    expect(termSource).not.toContain("syncTermWidthFit");
  });
});

describe("the new-output chip says how much arrived", () => {
  test("the chip carries a line count and a shape preview, not just an arrow", () => {
    state.paneId = "p1";
    state.paneText = "old";
    state.paneFollow = false;
    noteSnapshot("p1", ["old"], true);
    noteSnapshot("p1", ["old", "fresh"], false);
    state.paneUnread = true;
    paint();
    const jump = app.querySelector(".term-jump") as HTMLButtonElement;
    expect(jump.hidden).toBeFalse();
    expect(jump.getAttribute("aria-label")).toContain("新");
    expect(jump.querySelector(".term-jump-text")).toBeTruthy();
    expect(reactTerm).toContain('t("term.jumpLines", { n: count })');
    expect(reactTerm).toContain("unreadBars()");
    expect(reactTerm).toContain("term-jump-preview");
    expect(termSource).not.toContain("function fillJump(");
  });

  test("the chip travels to the newest output and only snaps under reduced motion", () => {
    const jump = body("jumpToBottom");
    expect(jump).toContain('behavior: "smooth"');
    expect(jump).toContain("prefersReducedMotion()");
    expect(jump).toContain("stickBottom()");
    expect(jump).toContain("jumpLeaving = true");
    expect(reactTerm).toContain("const leaving = termJumpLeaving()");
    expect(reactTerm).toContain('className={leaving ? "term-jump term-jump-out" : "term-jump"}');
  });

  test("a repaint that changed nothing does not raise the chip", () => {
    expect(viewSource).toContain("noteSnapshot(state.paneId ?? \"\", model.texts, following)");
    expect(viewSource).toContain("state.paneUnread = unreadCount() > 0");
    expect(viewSource).not.toContain("state.paneUnread = true");
  });
});

describe("terminal scroll restoration", () => {
  test("applies scroll after replaceChildren and again on the next frame", () => {
    expect(termSource).toContain("export function restoreTermScroll");
    expect(termSource).toContain("requestAnimationFrame(apply)");
  });
});
