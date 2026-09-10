import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./full-terminal.ts", import.meta.url)).text();
const fitController = await Bun.file(new URL("./full-terminal-fit-controller.ts", import.meta.url)).text();
const shell = await Bun.file(new URL("./full-terminal-view.ts", import.meta.url)).text();
const stateView = await Bun.file(new URL("./full-terminal-state.ts", import.meta.url)).text();
const dock = await Bun.file(new URL("../guided/session-dock.tsx", import.meta.url)).text();
const view = await Bun.file(new URL("../guided/session-pane.tsx", import.meta.url)).text();
// Back navigation lives in the pane-actions owner; the legacy pane painter is
// no longer the chain that leaves full-terminal (asserted as negatives below).
const pane = await Bun.file(new URL("../pane-actions.ts", import.meta.url)).text();
const paneActions = pane;
const appSource = await Bun.file(new URL("../../../app/App.tsx", import.meta.url)).text();
const framePrepare = await Bun.file(new URL("../../../app/frame-prepare.ts", import.meta.url)).text();
const swipe = await Bun.file(new URL("../guided/pane-swipe.ts", import.meta.url)).text();

function fn(name: string, next: string): string {
  const start = source.indexOf(name);
  const end = source.indexOf(next);
  // Both markers must exist and be ordered; never slice a missing/negative marker.
  expect(start, name).toBeGreaterThanOrEqual(0);
  expect(end, next).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("complete-terminal chrome stays a distinct surface", () => {
  test("chrome matches the other pane modes: stop, workspace, and more", async () => {
    // Preparation (document mode, renderer reset, status, initial view) runs in
    // an explicit prep function before React renders the declarative route; it
    // must not create a screen, adopt, or call a root renderer.
    const prepFn = fn("export function prepareFullTerminal(", "export function handleFullTerminalEvent(");
    expect(prepFn).toContain("setFullTerminalDocumentMode(true)");
    expect(prepFn).toContain("emitFullTerminalView");
    expect(prepFn).not.toContain("createElement");
    expect(prepFn).not.toContain("adoptExternalScreen");
    expect(prepFn).not.toContain("renderReactScreen");
    expect(source).toContain("emitFullTerminalView");
    expect(source).toContain("syncFullTerminalChrome");
    const reactShell = await Bun.file(new URL("./full-terminal-screen.tsx", import.meta.url)).text();
    expect(reactShell).toContain("full-terminal-chrome");
    expect(reactShell).toContain("SessionActions");
    expect(reactShell).toContain("working={view.working}");
    expect(reactShell).toContain("FullTerminalPad");
    // The terminal screen is composed declaratively, never injected.
    expect(reactShell).not.toContain("renderReactScreen");
    expect(reactShell).not.toContain("adoptExternalScreen");
    expect(reactShell).not.toContain("paintFullTerminalScreen");
    const route = await Bun.file(new URL("./full-terminal-route.tsx", import.meta.url)).text();
    expect(route).toContain("<FullTerminalScreen");
    expect(route).not.toContain("adoptExternalScreen");
    expect(route).not.toContain("renderReactScreen");
    expect(source).toContain("interruptFullTerminal");
    expect(prepFn).not.toContain('button("退出"');
    expect(prepFn).not.toContain("full-terminal-exit");
    expect(prepFn).not.toContain('button("重连"');
    expect(source).not.toContain("createFullTerminalView(");
    expect(source).not.toContain("app.replaceChildren(root)");
    expect(source).not.toContain("dockNode");
    expect(source).not.toContain("fillSession");
    expect(source).not.toContain("keyPad");
  });

  test("guided compose stays off the live xterm root", async () => {
    expect(source).not.toContain("dockNode");
    expect(source).not.toContain("composeForm");
    expect(source).toContain("bindHostScroll(");
    expect(source).toContain("sendFullTerminalScroll");
    expect(source).not.toContain("syncFullTerminalControls");
    expect(source).not.toContain("paintFullTerminalScreen");
    expect(source).toContain("prepareFullTerminal");
    expect(shell).toContain("publishFullTerminalView");
    expect(shell).not.toContain("createFullTerminalView");
    expect(shell).not.toContain("updateFullTerminalTitle");
    expect(stateView).not.toContain("fullTerminalStateLayer");
    expect(stateView).not.toContain("syncFullTerminalState");
    expect(fitController).toContain("pickFontSize");
    expect(source).toContain("bindFontPinch");
    expect(source).toContain("document.fonts");
    expect(fitController).toContain("Math.floor(inner.width / cell.width)");
    expect(fitController).toContain("ptyCols(visibleCols, termFit(), targetCols)");
    expect(fitController).toContain("panePtySize(openPaneId(), boardLayouts(), liveAgents())");
    expect(source).toContain("panXScroller");
    const host = await Bun.file(new URL("./full-terminal-host.tsx", import.meta.url)).text();
    expect(host).toContain("full-terminal-pan");
    expect(host).toContain("full-terminal-canvas");
    expect(host).toContain("SessionScrollRail");
    expect(host).toContain("FullTerminalStateLayer");
    expect(fitController).toContain("displayGrid");
    expect(fitController).toContain("remoteGrid");
    expect(fitController).toContain("pitchLineHeight");
    expect(fitController).toContain("measureGlyphHeight");
    expect(fitController).toContain("paintedFontSize");
    expect(fitController).toContain("snapCellLineHeight");
    expect(fitController).toContain("integerizeDomRows");
    expect(fitController).toContain("clearScreenScale");
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
    expect(view).toContain("Dock: SessionDock");
    expect(view).toContain("<Dock includeBack={includeBack} />");
  });

  test("a failed bridge stays in complete-terminal with retry", () => {
    const mountFn = fn("async function mount(", "function disposeRenderer(");
    expect(mountFn).not.toContain("state.fullTerminal = false");
    expect(mountFn).not.toContain("render()");
    expect(mountFn).toContain('t("ft.loadFail"');
    expect(mountFn).toContain("terminalStatus.fail");

    const openFn = fn("async function openBridge(", "async function suspendBridge(");
    expect(openFn).not.toContain("state.fullTerminal = false");
    expect(openFn).not.toContain("disposeRenderer()");
    expect(openFn).not.toContain("render()");
    expect(openFn).toContain("terminalStatus.fail");
    expect(openFn).toContain('t("ft.openFail"');
    expect(openFn).toContain("if (!session.isConnected())");
    expect(openFn).toContain("version !== bridgeVersion");
    expect(openFn.indexOf("version !== bridgeVersion", openFn.indexOf("catch (error)"))).toBeGreaterThan(
      openFn.indexOf("catch (error)"),
    );
  });

  test("complete-terminal entry has no hidden live-input coupling", () => {
    const enter = fn("export function enterFullTerminal(", "export function leaveFullTerminal(");
    expect(enter).not.toContain("fallbackToGuidedLive");
    expect(source).not.toContain("guidedLiveFallback");
  });

  test("checks the shared WebGL capability before activating the real addon", () => {
    expect(source).toContain("if (!terminalWebglSupported()) throw new Error(WEBGL_UNAVAILABLE)");
  });

  test("entering complete-terminal records the pane mode", () => {
    const enter = fn("export function enterFullTerminal(", "export function leaveFullTerminal(");
    expect(enter).toContain('setPaneTermMode(openPaneId(), "full")');
  });

  test("the requested PTY rows never exceed the local renderer above the pad", () => {
    const fitFn = fitController;
    expect(fitFn).toContain("displayGrid({ cols, rows }, remoteGrid)");
    expect(fitFn).toContain("hostFitRows");
    expect(fitFn).toContain("ptyCols(visibleCols, termFit(), targetCols)");
    expect(fitFn).toContain("panePtySize");
    expect(fitFn).toContain("sizePanCanvas");
    expect(fitFn).toContain("lockedFont !== null || pan");
    expect(fitFn).toContain("pitchLineHeight");
    expect(fitFn).toContain("clearScreenScale(host)");
    expect(fitFn).not.toContain("fillLineHeight");
    expect(fitFn).not.toContain("planScale");
    expect(fitFn).toContain("const size =");
    expect(source).toContain("fittedSize = result.size");
    expect(fitFn).toContain("measured?.width");
    expect(fitFn).toContain("measured?.height");
    const eventFn = fn("export function handleFullTerminalEvent(", "export function handleFullTerminalVisibility(");
    expect(eventFn).toContain("frame.width");
    expect(eventFn).toContain("frame.height");
    expect(eventFn).toContain("remoteGrid = nextRemote");
    expect(eventFn).toContain("enqueueResize");
    expect(eventFn).toContain("frameGate.settle(sequence, frame.full");
    expect(eventFn.indexOf("frameGate.settle(sequence, frame.full")).toBeLessThan(eventFn.indexOf("writer?.reset()"));
    expect(eventFn.indexOf("frameGate.settle(sequence, frame.full")).toBeLessThan(eventFn.indexOf("writer.write(frame.data"));
    const bindFn = fn("function bindInput(", "async function mount(");
    expect(bindFn).toContain("fittedSize.cols");
    expect(bindFn).toContain("fittedSize.rows");
    expect(bindFn).not.toContain("enqueueResize({ cols, rows");
  });

  test("retry remounts a missing renderer instead of leaving the mode", () => {
    const resume = fn("function resumeFullTerminal(", "export function retryFullTerminal(");
    const retry = fn("export function retryFullTerminal(", "export function enterFullTerminal(");
    const open = fn("async function openBridge(", "async function suspendBridge(");
    expect(resume).toContain("scheduleMount(host)");
    expect(resume).toContain("openBridge(false)");
    expect(resume).toContain("await openTracker.pending()");
    expect(resume).toContain("leaving");
    expect(resume).toContain("terminalDocumentHidden()");
    expect(resume).toContain("bridgeVersion++");
    expect(retry).toContain("resumeFullTerminal()");
    expect(retry).not.toContain("terminalStatus.start");
    expect(retry).not.toContain("state.fullTerminal = false");
    expect(open.indexOf('document.visibilityState === "hidden"')).toBeLessThan(open.indexOf("terminalStatus.start"));
  });

  test("drops stale frames before treating a forward sequence jump as a gap", () => {
    const eventFn = fn("export function handleFullTerminalEvent(", "export function handleFullTerminalVisibility(");
    expect(eventFn).toContain("frameGate.preflight(sequence, frame.full)");
    expect(eventFn.indexOf('admission === "stale"')).toBeLessThan(eventFn.indexOf('admission === "gap"'));
  });

  test("paints the loading shell before mounting xterm and skips the observer's initial duplicate fit", async () => {
    const engine = await Bun.file(new URL("./full-terminal-engine.ts", import.meta.url)).text();
    const mountFn = fn("async function mount(", "function disposeRenderer(");
    expect(engine).toContain("export function attachFullTerminalHost");
    expect(engine).toContain("scheduleMount(host)");
    expect(engine).not.toContain("leaveFullTerminal(");
    expect(source).not.toContain("paintFullTerminalScreen");
    expect(source).toContain("prepareFullTerminal");
    expect(source).toContain("afterNextPaint");
    expect(mountFn).toContain("observeHostResize(host");
    expect(mountFn.indexOf("fit();")).toBeLessThan(mountFn.indexOf("observeHostResize(host"));
  });

  test("leave paints the guided session itself and does not chain a list jump", () => {
    const leave = fn("export function leaveFullTerminal(", "export function disposeFullTerminal(");
    expect(leave).toContain("if (leaving) return leaving");
    expect(leave).toContain("setFullTerminal(false)");
    expect(leave).toContain("rememberGuided");
    expect(leave).toContain("setPaneTermMode(openPaneId(), \"guided\")");
    expect(leave).toContain("commitView()");
    // The full-terminal screen is now composed declaratively by the App route,
    // not painted from pane.ts; preparation runs in frame preparation.
    expect(appSource).toContain("<FullTerminalRoute");
    expect(framePrepare).toContain("prepareFullTerminal()");
    // The pane-actions owner does not chain a list jump through the old painter:
    // goBackFromPane is the named action below, never a `.then(goBackFromPane)`
    // or an `onExit:` painter callback.
    expect(pane).not.toContain(".then(goBackFromPane)");
    expect(pane).not.toContain("onExit:");
    // Back navigation lives with the pane actions; it uses the named domain
    // readers and the App commit seam, not the state facade or a painter.
    const back = paneActions.slice(paneActions.indexOf("export function goBackFromPane("),
      paneActions.indexOf("export function sessionHandlers("));
    expect(back).toContain("isFullTerminal()");
    expect(back).toContain("rememberGuided: false");
    expect(back).toContain("leavePaneScreen()");
    expect(back).not.toContain("state.fullTerminal");
  });

  test("document text autosizing is disabled only while complete-terminal is mounted", () => {
    const prepFn = fn("export function prepareFullTerminal(", "export function handleFullTerminalEvent(");
    const leaveFn = fn("export function leaveFullTerminal(", "export function disposeFullTerminal(");
    const disposeFn = fn("export function disposeFullTerminal(", "export function interruptFullTerminal(");
    expect(stateView).toContain('const FULL_TERMINAL_DOCUMENT_CLASS = "full-terminal-active"');
    expect(prepFn).toContain("setFullTerminalDocumentMode(true)");
    expect(leaveFn).toContain("setFullTerminalDocumentMode(false)");
    expect(disposeFn).toContain("setFullTerminalDocumentMode(false)");
  });

  test("edge swipe-back does not steal an 80-column terminal pan", () => {
    expect(swipe).toContain('closest?.(".full-terminal-pan")');
  });
});
