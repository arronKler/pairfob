import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./full-terminal.ts", import.meta.url)).text();
const dock = await Bun.file(new URL("./session/dock.ts", import.meta.url)).text();
const view = await Bun.file(new URL("./session/view.ts", import.meta.url)).text();
const pane = await Bun.file(new URL("./pane.ts", import.meta.url)).text();

function fn(name: string, next: string): string {
  const start = source.indexOf(name);
  const end = source.indexOf(next);
  expect(start, name).toBeGreaterThanOrEqual(0);
  expect(end, next).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("complete-terminal chrome stays a distinct surface", () => {
  test("chrome matches the other pane modes: stop plus more", () => {
    const renderFn = fn("export function renderFullTerminal(", "export function handleFullTerminalEvent(");
    expect(renderFn).toContain("chromeActionCluster(onMenu)");
    expect(renderFn).toContain("syncFullTerminalChrome()");
    expect(source).toContain("syncChromeStop(chrome, selectedAgent()?.status === \"working\", interruptFullTerminal)");
    expect(renderFn).not.toContain('button("退出"');
    expect(renderFn).not.toContain("full-terminal-exit");
    expect(renderFn).not.toContain('button("重连"');
    expect(renderFn).toContain('backButton(onBack, t("chrome.backList"))');
    expect(renderFn).toContain("onBack");
    expect(renderFn).not.toContain("goBackFromPane");
    expect(renderFn).toContain("scrollRail(");
    expect(renderFn).toContain("syncFullTerminalInput(root, host)");
    expect(renderFn).not.toContain("dockNode");
    expect(renderFn).not.toContain("fillSession");
    expect(renderFn).not.toContain("keyPad");
  });

  test("guided compose stays off the live xterm root", () => {
    expect(source).not.toContain("dockNode");
    expect(source).not.toContain("composeForm");
    expect(source).toContain("bindHostScroll(");
    expect(source).toContain("sendScroll");
    expect(source).toContain("syncFullTerminalControls");
    expect(source).toContain("pickFontSize");
    expect(source).toContain("bindFontPinch");
    expect(source).toContain("document.fonts");
    expect(source).toContain("Math.floor(inner.width / cell.width)");
    expect(source).toContain("ptyCols(visibleCols, state.termFit, state.termCols)");
    expect(source).toContain("panXScroller");
    expect(source).toContain("full-terminal-pan");
    expect(source).toContain("full-terminal-canvas");
    expect(source).toContain("displayGrid");
    expect(source).toContain("remoteGrid");
    expect(source).toContain("pitchLineHeight");
    expect(source).toContain("measureGlyphHeight");
    expect(source).toContain("paintedFontSize");
    expect(source).toContain("snapCellLineHeight");
    expect(source).toContain("integerizeDomRows");
    expect(source).toContain("clearScreenScale");
    expect(source).toContain("openWebglTerminal");
    expect(source).toContain("WEBGL_CONTEXT_LOST");
    expect(source).not.toContain("fillLineHeight");
    expect(source).not.toContain("planScale");
    expect(source).not.toContain("applyScreenScale");
    expect(source).not.toContain("host.clientWidth / cols");
    expect(source).toContain("bindXtermKeyboard");
    expect(source).toContain("closeTerminalKeyboard");
    expect(source).toContain("encodeTerminalKey");
    expect(source).not.toContain("keyPad");
    expect(dock).not.toContain("完整终端");
    expect(dock).not.toContain("重连");
    expect(dock).not.toContain("退出完整终端");
    expect(view).not.toContain("full-terminal-retry");
    expect(view).not.toContain("full-terminal-scroll");
    expect(view).toContain("dockNode(includeBack)");
  });

  test("a failed bridge stays in complete-terminal with retry", () => {
    const mountFn = fn("async function mount(", "function disposeRenderer(");
    expect(mountFn).not.toContain("state.fullTerminal = false");
    expect(mountFn).not.toContain("render()");
    expect(mountFn).toContain('t("ft.loadFail"');
    expect(mountFn).toContain("offerRetry");

    const openFn = fn("async function openBridge(", "async function suspendBridge(");
    expect(openFn).not.toContain("state.fullTerminal = false");
    expect(openFn).not.toContain("disposeRenderer()");
    expect(openFn).not.toContain("render()");
    expect(openFn).toContain("offerRetry");
    expect(openFn).toContain('t("ft.openFail"');
  });

  test("complete-terminal entry has no hidden live-input coupling", () => {
    const enter = fn("export function enterFullTerminal(", "export function leaveFullTerminal(");
    expect(enter).not.toContain("fallbackToGuidedLive");
    expect(source).not.toContain("guidedLiveFallback");
  });

  test("entering complete-terminal records the pane mode", () => {
    const enter = fn("export function enterFullTerminal(", "export function leaveFullTerminal(");
    expect(enter).toContain('setPaneTermMode(state.paneId, "full")');
  });

  test("a short remote frame shrinks the display grid then still asks for the phone size", () => {
    const fitFn = fn("function fit(", "function stopCommandPump(");
    expect(fitFn).toContain("displayGrid({ cols, rows }, remoteGrid)");
    expect(fitFn).toContain("ptyCols(visibleCols, state.termFit, state.termCols)");
    expect(fitFn).toContain("sizePanCanvas");
    expect(fitFn).toContain("lockedFont !== null || pan");
    expect(fitFn).toContain("pitchLineHeight");
    expect(fitFn).toContain("clearScreenScale(host)");
    expect(fitFn).not.toContain("fillLineHeight");
    expect(fitFn).not.toContain("planScale");
    expect(fitFn).toContain("fittedSize =");
    expect(fitFn).toContain("measured?.width");
    expect(fitFn).toContain("measured?.height");
    const eventFn = fn("export function handleFullTerminalEvent(", "export function handleFullTerminalVisibility(");
    expect(eventFn).toContain("frame.width");
    expect(eventFn).toContain("frame.height");
    expect(eventFn).toContain("remoteGrid = nextRemote");
    expect(eventFn).toContain("enqueueResize");
    const bindFn = fn("function bindInput(", "async function mount(");
    expect(bindFn).toContain("fittedSize.cols");
    expect(bindFn).toContain("fittedSize.rows");
    expect(bindFn).not.toContain("enqueueResize({ cols, rows");
  });

  test("retry remounts a missing renderer instead of leaving the mode", () => {
    const retry = fn("export function retryFullTerminal(", "export function enterFullTerminal(");
    expect(retry).toContain("mount(host)");
    expect(retry).toContain("openBridge(false)");
    expect(retry).not.toContain("state.fullTerminal = false");
  });

  test("leave paints the guided session itself and does not chain a list jump", () => {
    const leave = fn("export function leaveFullTerminal(", "export function disposeFullTerminal(");
    expect(leave).toContain("if (leaving) return leaving");
    expect(leave).toContain("state.fullTerminal = false");
    expect(leave).toContain("rememberGuided");
    expect(leave).toContain("setPaneTermMode(state.paneId, \"guided\")");
    expect(leave).toContain("render()");
    expect(pane).not.toContain("onFullTerminal: enterFullTerminal");
    expect(pane).toContain("renderFullTerminal(goBackFromPane, openPaneMenu)");
    expect(pane).not.toContain(".then(goBackFromPane)");
    expect(pane).not.toContain("onExit:");
    const back = pane.slice(pane.indexOf("export function goBackFromPane("), pane.indexOf("export function sessionHandlers("));
    expect(back).toContain("if (state.fullTerminal)");
    expect(back).toContain("rememberGuided: false");
    expect(back).toContain('state.screen = "home"');
  });

  test("document text autosizing is disabled only while complete-terminal is mounted", () => {
    const renderFn = fn("export function renderFullTerminal(", "export function handleFullTerminalEvent(");
    const leaveFn = fn("export function leaveFullTerminal(", "export function disposeFullTerminal(");
    const disposeFn = fn("export function disposeFullTerminal(", "function interruptFullTerminal(");
    expect(source).toContain('const FULL_TERMINAL_DOCUMENT_CLASS = "full-terminal-active"');
    expect(renderFn).toContain("setFullTerminalDocumentMode(true)");
    expect(leaveFn).toContain("setFullTerminalDocumentMode(false)");
    expect(disposeFn).toContain("setFullTerminalDocumentMode(false)");
  });

  test("edge swipe-back does not steal an 80-column terminal pan", () => {
    expect(pane).toContain('closest?.(".full-terminal-pan")');
  });
});
