import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { ScalarPreferenceState } from "../../../../test-support/preferences-scalar-restore";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { appRoot } from "../../../app/dom-root";

const { setLang } = await import("../../../lib/i18n");
const { clearNotice } = await import("../../../app/notices-store");
const { setScreen } = await import("../../../app/navigation-store");
const { applyPaneRead, selectPane, setAgentChat, setFullTerminal, setPaneFollow, setPaneRow, setPaneUnread, setTermSelect } = await import("../session-store");
const { setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } = await import("../compose-store");
const { setDefaultComposeLive, setKeysExpanded, setPadKind, setTermWrap } = await import("../../settings/preferences-store");
const { setOperationBusy } = await import("../../operations/capabilities-store");
const { attachLiveSession } = await import("../../computers/catalog-store");
const { setPhase } = await import("../../connection/connection-store");
const { noteSnapshot } = await import("./unread");
const { SessionTerminal } = await import("./session-terminal");

// The preference setters below (setDefaultComposeLive / setKeysExpanded /
// setPadKind / setTermWrap) each persist to storage via their own saveX() ->
// writeStorage, so under pre-pollution (e.g. a prior run left termWrap=true,
// canonical AND raw) a beforeEach reset to false writes "0" to the raw key.
// ScalarPreferenceState restores canonical (in-memory) and raw (storage)
// pre-images separately after every case.
const scalarPreferenceState = new ScalarPreferenceState();

const termSource = await Bun.file(new URL("./term.ts", import.meta.url)).text();
const keysSource = await Bun.file(new URL("./keys.ts", import.meta.url)).text();
// 40b54c8 colocated the live connection module into features/connection/controller;
// live.ts is now a retire-pending re-export shim, so this source-read oracle points
// at the real owner where patchSessionScreen() is actually called.
const liveSource = await Bun.file(new URL("../../connection/controller.ts", import.meta.url)).text();
const viewSource = await Bun.file(new URL("./view.ts", import.meta.url)).text();
const reactTerm = await Bun.file(new URL("./session-terminal.tsx", import.meta.url)).text();
const reactRail = await Bun.file(new URL("./session-scroll.tsx", import.meta.url)).text();

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
  renderReact(createElement(SessionTerminal));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
  setLang("zh");
  clearNotice();
  // Capture the polluted canonical+raw pre-images BEFORE any preference setter
  // runs, so a later reset that persists cannot be mistaken for the pre-state.
  scalarPreferenceState.capture();
  // Restore the full baseline the old Object.assign(state, {...}) +
  // flushDirtyDomains() established, through the named owners. Nothing is
  // mounted yet (unmountReact above), so the immediate publishes from write()-
  // based actions notify no React subscriber. The staged actions (selectPane,
  // setAgentChat, setFullTerminal) publish headlessly via composeTransaction.
  //
  // termSelect=false is load-bearing: displayedTermModel lazily clears its
  // frozen module-state when termSelect() is false, so a prior selection's
  // frozen rows cannot survive into the next case. termWrap=false is equally
  // required: SessionTerminal reads it during render, and a stale true would
  // wrap rows the max-content canvas case must render unwrapped.
  //
  // The four preference setters persist via saveX() -> writeStorage; the
  // captured canonical+raw pre-images are restored in afterEach so a reset's
  // write cannot leak beyond this case.
  // agents (dashboard) and paneComposeLive (preferences map) have no narrow
  // owner setter; SessionTerminal does not subscribe to the dashboard domain
  // or read paneComposeLive, so both are audited-irrelevant to this leaf and
  // are not reset to avoid the broad resetDashboard()/resetPreferences()
  // side-effects flagged for the QA view fixture.
  setPhase("live");
  setScreen("home");
  selectPane("");
  applyPaneRead("", "");
  setFullTerminal(false);
  setAgentChat(false);
  setTermSelect(false);
  setPaneRow(null);
  setPaneFollow(true);
  setPaneUnread(false);
  setOperationBusy(false);
  setComposeDraft("");
  setComposeLive(false);
  setComposeIME(false);
  setComposeFocused(false);
  setDefaultComposeLive(false);
  setKeysExpanded(false);
  setPadKind("keys");
  setTermWrap(false);
  attachLiveSession(null);
});

afterEach(() => {
  setTermSelect(false);
  setPaneFollow(true);
  setPaneUnread(false);
  applyPaneRead("", "");
  unmountReact();
  clearNotice();
  appRoot().replaceChildren();
  scalarPreferenceState.restore();
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
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("hello\nworld", "");
    setTermSelect(false);
    paint();
    const rows = [...appRoot().querySelectorAll(".term-line")];
    expect(rows.map((row) => row.getAttribute("data-row"))).toEqual(["0", "1"]);
    expect(rows[0]?.textContent).toContain("hello");
    expect(rows[1]?.textContent).toContain("world");
    expect(appRoot().querySelector('.term-line[role="button"]')).toBeNull();
    expect(appRoot().querySelector(".term-option")).toBeNull();
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
    applyPaneRead("short\n" + "x".repeat(80), "");
    paint();
    const inner = appRoot().querySelector(".term-inner");
    const term = appRoot().querySelector(".term");
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
    applyPaneRead("ready", "");
    paint();
    expect(appRoot().querySelector(".full-terminal-scroll")).toBeTruthy();
    expect([...appRoot().querySelectorAll(".full-terminal-scroll-btn")].map((el) => el.getAttribute("aria-label"))).toEqual([
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
    selectPane("p1");
    applyPaneRead("old", "");
    setPaneFollow(false);
    noteSnapshot("p1", ["old"], true);
    noteSnapshot("p1", ["old", "fresh"], false);
    setPaneUnread(true);
    paint();
    const jump = appRoot().querySelector(".term-jump") as HTMLButtonElement;
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
    expect(viewSource).toContain("noteSnapshot(bound.paneId, model.texts, following)");
    expect(viewSource).toContain("setPaneUnread(unreadCount() > 0)");
    expect(viewSource).not.toContain("state.paneUnread = true");
  });
});

describe("terminal scroll restoration", () => {
  test("applies scroll after replaceChildren and again on the next frame", () => {
    expect(termSource).toContain("export function restoreTermScroll");
    expect(termSource).toContain("requestAnimationFrame(apply)");
  });
});
