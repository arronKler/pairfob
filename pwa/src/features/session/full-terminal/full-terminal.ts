import { TerminalRecoveryDiagnostics } from "./terminal-recovery-diagnostics";
import { encodeLiveKey } from "../keypad/live-key";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { agentTitle } from "../../../lib/dashboard";
import { copy, t, type LocalizedText } from "../../../lib/i18n";
import { canInterruptAgent } from "../../connection/runtime-status";
import {
  ProtocolError,
  TerminalFrameAssembler,
  TERMINAL_MAX_ROWS,
  type SessionEvent,
} from "../../../lib/protocol/client";
import { appRoot } from "../../../app/dom-root";
import { selectedAgent } from "../../dashboard/catalog-store";
import { composeLive } from "../compose-store";
import { liveSession } from "../../computers/catalog-store";
import { termCols, termFit, termFontPx, setPaneTermMode, setTermGrid, type TermCols, type TermFit } from "../../settings/preferences-store";
import { isFullTerminal, openPaneId, setAgentChat, setFullTerminal } from "../session-store";
import { commitView } from "../../../app/host";
import { applyComposeDraft, bumpViewIncarnation, captureComposeDraft, currentViewIncarnation, switchComposeView } from "../drafts/compose-drafts";
import { haptic } from "../../../lib/dom";
import { messageCopy } from "../../../lib/notices";
import { hardwareKeyboard, hasTouch } from "../../../app/input-mode";
import { sessionMayTakeFocus } from "../focus";
import {
  bindFontPinch,
  clamp,
  frameMatchesGrid,
  FULL_TERM_FONT_FAMILY,
  measureGlyphHeight,
  pitchLineHeight,
  terminalCellAt,
  terminalCellPoint,
  terminalGridSize,
  terminalMount,
} from "./full-terminal-fit";
import { fitFullTerminal, type FullTerminalFitHold, type FullTerminalFittedSize } from "./full-terminal-fit-controller";
import { flyKeyToCursor } from "../guided/key-flight";
import {
  bindXtermKeyboard,
  encodeTerminalKey,
  httpLinkProvider,
  notifyFullTerminalKeyboard,
  terminalLinkHandler,
  type TerminalKeyboard,
} from "./full-terminal-input";
import { setFullTerminalInputMode, submitFullTerminalCompose, type FullTerminalControlsOptions } from "./full-terminal-compose";
import { bindTerminalCopyKey, copyTerminalSelection } from "./full-terminal-copy";
import { bindHostScroll, pageLineCount, reportsWheel, type ScrollAt } from "./full-terminal-scroll";
import { attachFullTerminalHost, clearFullTerminalAttach, connectFullTerminalEngine, fullTerminalOwnerKey } from "./full-terminal-engine";
import { releaseFullTerminalScreen } from "./full-terminal-screen";
import { TerminalCommandPump, type TerminalCommand, type TerminalInputQueueOptions } from "./full-terminal-command";
import { loadFullTerminalXterm, terminalWebglSupported } from "./full-terminal-loader";
import { afterNextPaint, observeHostResize } from "./full-terminal-lifecycle";
import { followCursor } from "./full-terminal-lift";
import { fullTerminalPerf } from "./full-terminal-perf";
import { FullTerminalFrameGate } from "./full-terminal-frame-gate";
import { FullTerminalOpenTracker } from "./full-terminal-open-tracker";
import { FullTerminalResizeGate } from "./full-terminal-resize";
import { terminalRoomHeight } from "./full-terminal-room";
import { fullTerminalOptions, terminalScreenText, openWebglTerminal, WEBGL_CONTEXT_LOST, WEBGL_UNAVAILABLE } from "./full-terminal-renderer";
import {
  FullTerminalStatus,
  setFullTerminalDocumentMode,
} from "./full-terminal-state";
import { track } from "../../../lib/telemetry";
import { guidedScrollController } from "../guided/guided-scroll";
import { publishFullTerminalView, resetFullTerminalView, type FullTerminalViewSnapshot } from "./full-terminal-view";

let terminalRecovery: TerminalRecoveryDiagnostics | undefined;

// #app is resolved lazily inside each DOM-owning function below: importing
// this controller must not require a document.

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ReturnType<typeof observeHostResize> = null;
let unbindScroll: (() => void) | null = null;
let unbindPinch: (() => void) | null = null;
let unbindCopy: (() => void) | null = null;
let keyboard: TerminalKeyboard | null = null;
let lockedFont: number | null = null;
let fitting = false;
let pinchResizeTimer = 0;
let mounting = false;
let cancelMount: (() => void) | null = null;
let rendererVersion = 0;
let bridgeId = "";
let bridgePane = "";
let bridgeVersion = 0;
let opening = false;
let leaving: Promise<void> | null = null;
export type FullTerminalLeaveTransition = { from: number; to: number };
let leaveResult: { transition: FullTerminalLeaveTransition | null } | null = null;
let leaveSeq = 0;
let commandPump: TerminalCommandPump | null = null;
const frameGate = new FullTerminalFrameGate();
const openTracker = new FullTerminalOpenTracker();
const resizeGate = new FullTerminalResizeGate();
let pendingWriteBytes = 0;
/** The mounted shell still belongs to this controller, even during a visible load error. */
let terminalShellActive = false;
/** Last terminal.frame grid. Display clamps to this so a short PTY can scale-fill. */
let remoteGrid: { cols: number; rows: number } | null = null;
/** Latest phone-sized PTY request and cell metrics. */
let fittedSize: FullTerminalFittedSize | null = null;
/** Requested columns kept until the window itself resizes; a new renderer measures afresh. */
let fitHold: FullTerminalFitHold | null = null;
const assembler = new TerminalFrameAssembler();
const MAX_RENDER_QUEUE_BYTES = 8 * 1024 * 1024;
const terminalStatus = new FullTerminalStatus(() => {
  emitFullTerminalView();
});

function captureFullTerminalView(): FullTerminalViewSnapshot {
  const selected = selectedAgent();
  return {
    owner: fullTerminalOwnerKey(),
    paneId: openPaneId(),
    title: selected ? agentTitle(selected) : t("title.terminal"),
    working: canInterruptAgent(selected?.status ?? ""),
    stage: terminalStatus.stage,
    detail: terminalStatus.detail,
    retry: Boolean(isFullTerminal() && terminalStatus.retry && !opening && !bridgeId),
    busy: opening,
    composeLive: composeLive(),
    keyboardOpen: keyboard?.isOpen() === true,
  };
}

function emitFullTerminalView(): void {
  const view = captureFullTerminalView();
  notifyFullTerminalKeyboard(view.keyboardOpen);
  publishFullTerminalView(view);
}

function terminalDocumentHidden(): boolean { return document.visibilityState === "hidden"; }

function fit(): { cols: number; rows: number; cellWidth: number; cellHeight: number } {
  const fallback = { cols: 80, rows: 24, cellWidth: 0, cellHeight: 0 };
  const app = appRoot();
  const host = app.querySelector(".full-terminal-host") as HTMLElement | null;
  if (!terminal || !fitAddon || !host) return fallback;
  if (fitting) return fittedSize ?? terminalGridSize(app, terminal, terminal.cols || 80, terminal.rows || 24);
  fitting = true;
  try {
    const result = fitFullTerminal({ root: app, host, terminal, fitAddon, lockedFont, remoteGrid, hold: fitHold });
    if (!result) return fallback;
    remoteGrid = result.remoteGrid;
    fittedSize = result.size;
    fitHold = result.hold;
    return result.size;
  } finally {
    fitting = false;
  }
}

function stopCommandPump(): void {
  commandPump?.stop();
  commandPump = null;
}

function startCommandPump(
  session: NonNullable<ReturnType<typeof liveSession>>,
  terminalId: string,
  version: number,
): void {
  stopCommandPump();
  const execute = (command: TerminalCommand, sequence: number): Promise<unknown> => {
    if (version !== bridgeVersion || bridgeId !== terminalId || liveSession() !== session || !isFullTerminal()) {
      return Promise.reject(new ProtocolError("conflict", t("err.controllerSwitch")));
    }
    if (command.kind === "input") return session.terminalInput(terminalId, sequence, command.data);
    if (command.kind === "resize") {
      return session.terminalResize(
        terminalId,
        sequence,
        command.cols,
        command.rows,
        command.cellWidth,
        command.cellHeight,
      );
    }
    return session.terminalScroll(
      terminalId,
      sequence,
      command.direction,
      command.lines,
      command.source,
      command.at,
    );
  };
  commandPump = new TerminalCommandPump({
    execute,
    observer: fullTerminalPerf.commandObserver,
    onError: (error) => {
      if (version !== bridgeVersion) return;
      fullTerminalPerf.publish("command_error");
      void suspendBridge(true, copy("ft.interrupt", { error: messageCopy(error) }));
    },
  });
}

/** Ask the computer for `size` unless it was already asked; `remote` is the grid its newest frame reported. */
function requestResize(size: FullTerminalFittedSize, remote?: { cols: number; rows: number }): void {
  if (!bridgeId || opening || !commandPump || !resizeGate.admit(size, remote)) return;
  commandPump.enqueueResize({ cols: size.cols, rows: size.rows, cellWidth: size.cellWidth, cellHeight: size.cellHeight });
}

function sendInput(data: Uint8Array, options?: TerminalInputQueueOptions): void {
  commandPump?.enqueueInput(data, options);
}

function sendComposedInput(text: string, enter: boolean): boolean {
  return submitFullTerminalCompose(text, enter, Boolean(bridgeId && !opening && commandPump), sendInput);
}

function terminalGrid(): { cols: number; rows: number } {
  return { cols: terminal?.cols || 80, rows: terminal?.rows || 24 };
}

function cellAt(clientX: number, clientY: number): ScrollAt | undefined {
  const host = appRoot().querySelector(".full-terminal-host") as HTMLElement | null;
  if (!terminal || !host) return;
  return terminalCellAt(host, terminalGrid(), clientX, clientY);
}

function closeTerminalKeyboard(): void {
  keyboard?.close();
  emitFullTerminalView();
}

export function sendFullTerminalScroll(direction: "up" | "down", lines: number, source: "wheel" | "page_key", at?: ScrollAt): void {
  closeTerminalKeyboard();
  if (!bridgeId || opening || !commandPump) return;
  const count = clamp(Math.round(lines), 1, TERMINAL_MAX_ROWS);
  commandPump.enqueueScroll({ direction, lines: count, source, at });
}

export function pageScrollLines(): number {
  return clamp(pageLineCount(terminal?.rows || fittedSize?.rows || 24), 1, TERMINAL_MAX_ROWS);
}

/** The caret in viewport coordinates. xterm draws it on canvas, so read the buffer. */
function caretPoint(): { x: number; y: number } | null {
  const host = appRoot().querySelector(".full-terminal-host") as HTMLElement | null;
  if (!terminal || !host) return null;
  const buffer = terminal.buffer.active;
  return terminalCellPoint(host, terminalGrid(), { column: buffer.cursorX, row: buffer.cursorY });
}

function sendPadKey(key: string, source?: HTMLElement | null): void {
  if (!terminal || !bridgeId || opening) return;
  const bytes = encodeTerminalKey(key, terminal.modes.applicationCursorKeysMode);
  if (!bytes) return;
  haptic(4, source);
  flyKeyToCursor(source, appRoot().querySelector<HTMLElement>(".full-terminal-host"), key, caretPoint());
  terminal.input(bytes);
}

function bindInput(host: HTMLElement): void {
  const app = appRoot();
  if (!terminal) return;
  terminal.onData((value) => sendInput(new TextEncoder().encode(encodeLiveKey(value))));
  terminal.onBinary((value) => {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 0xff;
    sendInput(bytes);
  });
  terminal.onResize(() => {
    if (!fitting && fittedSize) requestResize(fittedSize);
  });
  unbindScroll?.();
  unbindScroll = bindHostScroll(host, sendFullTerminalScroll, cellAt, {
    // Fixed columns pan, and so do columns the inspector is covering.
    panXScroller: () => host.classList.contains("is-pan") ? host.querySelector<HTMLElement>(".full-terminal-pan") : null,
    wheelReported: () => reportsWheel(terminal?.modes.mouseTrackingMode),
  });
  unbindCopy?.();
  unbindCopy = bindTerminalCopyKey(host, () => terminal);
  unbindPinch?.();
  unbindPinch = bindFontPinch(
    host,
    () => lockedFont ?? terminal?.options.fontSize ?? termFontPx(),
    (px) => {
      lockedFont = px;
      fit();
      window.clearTimeout(pinchResizeTimer);
      pinchResizeTimer = window.setTimeout(() => {
        if (terminal) requestResize(terminalGridSize(app, terminal, terminal.cols || 80, terminal.rows || 24));
      }, 120);
    },
  );
  keyboard = bindXtermKeyboard(host, composeLive() && hardwareKeyboard(), sessionMayTakeFocus);
  emitFullTerminalView();
}

function webglFailure(error: unknown): LocalizedText {
  const message = error instanceof Error ? error.message : "";
  if (message === WEBGL_CONTEXT_LOST) return copy("ft.webglLost");
  if (message === WEBGL_UNAVAILABLE) return copy("ft.webglUnavailable");
  return messageCopy(error);
}

function handleRendererContextLoss(version: number): void {
  if (version !== rendererVersion || !isFullTerminal()) return;
  const reason = copy("ft.loadFail", { error: copy("ft.webglLost") });
  void suspendBridge(true, reason);
  disposeRenderer();
  terminalStatus.fail(reason);
}

function scheduleMount(host: HTMLElement): void {
  cancelMount?.();
  cancelMount = afterNextPaint(() => {
    cancelMount = null;
    if (!isFullTerminal() || !host.isConnected) return;
    void mount(host);
  });
}

async function mount(host: HTMLElement): Promise<void> {
  const version = ++rendererVersion;
  mounting = true;
  terminalStatus.reset(copy("ft.preparing"));
  let module: typeof import("./full-terminal-xterm.ts");
  try {
    module = await loadFullTerminalXterm();
  } catch (error) {
    if (version !== rendererVersion) return;
    mounting = false;
    terminalStatus.fail(copy("ft.loadFail", { error: webglFailure(error) }));
    return;
  }
  if (version !== rendererVersion || !isFullTerminal() || !host.isConnected) return;
  mounting = false;
  const fontPx = termFontPx();
  terminal = new module.Terminal(fullTerminalOptions({
    fontFamily: FULL_TERM_FONT_FAMILY,
    fontSize: fontPx,
    lineHeight: pitchLineHeight(
      fontPx,
      measureGlyphHeight(FULL_TERM_FONT_FAMILY, fontPx),
      window.devicePixelRatio || 1,
      24,
    ),
    linkHandler: terminalLinkHandler(),
  }));
  fitAddon = new module.FitAddon();
  terminal.loadAddon(fitAddon);
  try {
    if (!terminalWebglSupported()) throw new Error(WEBGL_UNAVAILABLE);
    openWebglTerminal(terminal, module.WebglAddon, terminalMount(host), () => handleRendererContextLoss(version));
  } catch (error) {
    if (version !== rendererVersion) return;
    disposeRenderer();
    terminalStatus.fail(copy("ft.loadFail", { error: webglFailure(error) }));
    return;
  }
  fullTerminalPerf.componentReady();
  const start = async () => {
    try {
      await document.fonts?.ready;
    } catch {
      /* system fonts; a missing FontFaceSet must not block the bridge */
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (version !== rendererVersion || !host.isConnected) return;
    fit();
    terminal?.registerLinkProvider(httpLinkProvider(terminal));
    bindInput(host);
    // The host also resizes when the inspector opens, the list gives way, a
    // mouse calls up the key pad or a draft grows a line. Those leave the
    // fitted size as it was, and the computer's terminal alone.
    resizeObserver = observeHostResize(host, () => requestResize(fit()),
      // An on-screen keyboard slides the height over several frames; wait for it.
      { settleHeight: hasTouch(), roomHeight: () => terminalRoomHeight(host) });
    if (!(composeLive() && hardwareKeyboard())) closeTerminalKeyboard();
    else if (sessionMayTakeFocus()) terminal?.focus();
    void openTracker.run(() => openBridge(false));
  };
  void start();
}

function disposeRenderer(): void {
  terminalRecovery = undefined;
  rendererVersion++;
  cancelMount?.();
  cancelMount = null;
  stopCommandPump();
  unbindScroll?.();
  unbindScroll = null;
  unbindPinch?.();
  unbindPinch = null;
  unbindCopy?.();
  unbindCopy = null;
  lockedFont = null;
  fitting = false;
  remoteGrid = null;
  fittedSize = null;
  fitHold = null;
  window.clearTimeout(pinchResizeTimer);
  pinchResizeTimer = 0;
  keyboard?.close();
  keyboard?.destroy();
  keyboard = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
  assembler.reset();
  frameGate.reset();
  pendingWriteBytes = 0;
}

async function openBridge(takeover: boolean): Promise<void> {
  const session = liveSession();
  const paneId = openPaneId();
  if (opening || bridgeId || !terminal || !session || !paneId || !isFullTerminal() || document.visibilityState === "hidden") return;
  if (!session.isConnected()) {
    terminalStatus.wait(copy("ft.waitRestore"));
    return;
  }
  const version = ++bridgeVersion;
  opening = true;
  terminalStatus.start(copy(takeover ? "ft.takeover" : "ft.opening"), "opening");
  fullTerminalPerf.bridgeStarted();
  const recovery = new TerminalRecoveryDiagnostics(session.connectionRecovery?.());
  try {
    const size = fittedSize ?? fit();
    resizeGate.opened(size);
    const opened = await session.terminalOpen(paneId, size.cols, size.rows, takeover);
    if (version !== bridgeVersion || !isFullTerminal() || liveSession() !== session || openPaneId() !== paneId) {
      await session.terminalClose(opened.terminalId).catch(() => undefined);
      return;
    }
    bridgeId = opened.terminalId;
    bridgePane = paneId;
    startCommandPump(session, opened.terminalId, version);
    fullTerminalPerf.bridgeOpened();
    terminalRecovery = recovery;
    recovery.opened();
    assembler.reset();
    frameGate.reset();
    terminalStatus.start(copy("ft.live"), "live");
    // A hardware keyboard types into the terminal once it is live, unless the
    // list, the inspector or a dialog holds it; touch waits to be asked for keys.
    if (hardwareKeyboard() ? sessionMayTakeFocus() : keyboard?.isOpen()) terminal?.focus();
    else if (!hardwareKeyboard()) closeTerminalKeyboard();
  } catch (error) {
    if (version !== bridgeVersion || !isFullTerminal() || liveSession() !== session || openPaneId() !== paneId) return;
    if (error instanceof ProtocolError && error.code === "conflict" && !takeover
      && window.confirm(t("ft.takeoverAsk"))) {
      opening = false;
      await openBridge(true);
      return;
    }
    terminalStatus.fail(copy("ft.openFail", { error: messageCopy(error) }));
  } finally {
    if (version === bridgeVersion) {
      opening = false;
      emitFullTerminalView();
    }
  }
}

async function suspendBridge(sendClose: boolean, reason?: LocalizedText, showFailure = true): Promise<void> {
  const session = liveSession();
  const id = bridgeId;
  const renderer = rendererVersion;
  const pendingOpen = openTracker.pending();
  terminalRecovery = undefined;
  stopCommandPump();
  const version = ++bridgeVersion;
  bridgeId = "";
  bridgePane = "";
  assembler.reset();
  frameGate.reset();
  pendingWriteBytes = 0;
  remoteGrid = null;
  opening = false;
  await pendingOpen;
  if (sendClose && session && id) await session.terminalClose(id).catch(() => undefined);
  emitFullTerminalView();
  if (!showFailure || version !== bridgeVersion || renderer !== rendererVersion || bridgeId || opening || !isFullTerminal()) return;
  terminalStatus.fail(reason ?? copy("ft.paused"));
}

async function resumeFullTerminal(): Promise<void> {
  if (opening || bridgeId || leaving || terminalDocumentHidden()) return;
  await openTracker.pending();
  if (opening || bridgeId || leaving || !isFullTerminal() || terminalDocumentHidden()) return;
  const app = appRoot();
  const host = app.querySelector(".full-terminal-host") as HTMLElement | null;
  if (!terminal) {
    if (!mounting && host?.isConnected) {
      bridgeVersion++;
      scheduleMount(host);
    }
    return;
  }
  fit();
  void openTracker.run(() => openBridge(false));
}

export function retryFullTerminal(): void {
  if (opening || bridgeId) return;
  haptic(8);
  void resumeFullTerminal();
}

export function setTermFit(next: TermFit, cols: TermCols = termCols()): void {
  if (termFit() === next && termCols() === cols) return;
  setTermGrid(next, cols);
  const host = appRoot().querySelector(".full-terminal-host") as HTMLElement | null;
  host?.classList.toggle("is-pan", next === "pan");
  if (next !== "pan") {
    const scroller = host?.querySelector(".full-terminal-pan");
    if (scroller instanceof HTMLElement) scroller.scrollLeft = 0;
  }
  if (!isFullTerminal() || !terminal) return;
  requestResize(fit());
}

export function enterFullTerminal(): void {
  if (!liveSession() || !openPaneId() || isFullTerminal()) return;
  guidedScrollController.dispose();
  haptic(8);
  track("pwa_terminal");
  switchComposeView(() => {
    setPaneTermMode(openPaneId(), "full");
    setAgentChat(false);
    setFullTerminal(true);
  });
  terminalStatus.reset(copy("ft.preparing"));
  commitView();
}

export function leaveFullTerminal(opts?: { rememberGuided?: boolean; paint?: boolean }): Promise<void> {
  if (leaving) return leaving;
  if (!isFullTerminal()) return Promise.resolve();
  const seq = ++leaveSeq;
  const rememberGuided = opts?.rememberGuided !== false;
  const paint = opts?.paint !== false;
  captureComposeDraft();
  const result = { transition: null as FullTerminalLeaveTransition | null };
  leaveResult = result;
  leaving = (async () => {
    try {
      await suspendBridge(true, undefined, false);
      if (seq !== leaveSeq) return;
      const from = currentViewIncarnation();
      disposeRenderer();
      terminalShellActive = false;
      clearFullTerminalAttach();
      releaseFullTerminalScreen();
      resetFullTerminalView();
      fullTerminalPerf.publish("leave");
      if (rememberGuided) setPaneTermMode(openPaneId(), "guided");
      setFullTerminal(false);
      setFullTerminalDocumentMode(false);
      const to = bumpViewIncarnation();
      result.transition = { from, to };
      applyComposeDraft();
      if (paint) commitView();
    } finally {
      if (seq === leaveSeq) leaving = null;
    }
  })();
  return leaving;
}

/** Actual view transition made by this shared leave; no caller predicts its increments. */
export async function leaveFullTerminalWithTransition(opts?: { rememberGuided?: boolean; paint?: boolean }): Promise<FullTerminalLeaveTransition | null> {
  if (!isFullTerminal() && !leaving) return null;
  const pending = leaveFullTerminal(opts);
  const result = leaveResult;
  await pending;
  return result?.transition ?? null;
}

export function disposeFullTerminal(): void {
  leaveSeq++;
  leaving = null;
  setFullTerminal(false);
  terminalShellActive = false;
  setFullTerminalDocumentMode(false);
  terminalStatus.clearRetry();
  bridgeId = "";
  bridgePane = "";
  stopCommandPump();
  bridgeVersion++;
  opening = false;
  disposeRenderer();
  clearFullTerminalAttach();
  releaseFullTerminalScreen();
  resetFullTerminalView();
}

export function interruptFullTerminal(): void {
  sendPadKey("esc");
}

export function fullTerminalControlOptions(): FullTerminalControlsOptions {
  return {
    sendKey: sendPadKey,
    sendCompose: sendComposedInput,
    hardwareKeyboard: hardwareKeyboard(),
    setLive: setFullTerminalComposeLive,
    copySelection: () => copyTerminalSelection(terminal),
    keyboard: {
      toggle: () => {
        const host = appRoot().querySelector<HTMLElement>(".full-terminal-host");
        if (!keyboard && host) keyboard = bindXtermKeyboard(host, false);
        keyboard?.toggle();
        emitFullTerminalView();
      },
      open: (take = true) => {
        keyboard?.open(take);
        if (take) terminal?.focus();
        emitFullTerminalView();
      },
      close: closeTerminalKeyboard,
      isOpen: () => keyboard?.isOpen() === true,
    },
  };
}

/** The reader chose this terminal again. One that is still opening takes the keyboard itself once it is live. */
export function focusFullTerminal(): void {
  terminal?.focus();
}

export function syncFullTerminalChrome(): void {
  emitFullTerminalView();
}

export function setFullTerminalComposeLive(live: boolean): void {
  setFullTerminalInputMode(live, sendComposedInput, () => {
    emitFullTerminalView();
  });
}

export function prepareFullTerminal(): void {
  // Frame preparation, run before React renders the declarative route. Owns the
  // document mode, owner-shell check, renderer retirement/reset, status and
  // performance begin, and publishes the initial view. It must NOT create a
  // ReactElement, paint, adopt a screen, or call a root renderer; the App
  // composes <FullTerminalRoute/> declaratively and the engine attaches from
  // FullTerminalHost's own layout effect.
  setFullTerminalDocumentMode(true);
  const mounted = appRoot().querySelector<HTMLElement>(".full-terminal-root");
  if (terminalShellActive && mounted?.dataset.terminalOwner === fullTerminalOwnerKey()) {
    emitFullTerminalView();
    return;
  }
  disposeRenderer();
  terminalStatus.reset(copy("ft.preparing"));
  fullTerminalPerf.begin();
  terminalShellActive = true;
  emitFullTerminalView();
}

export function handleFullTerminalEvent(event: SessionEvent): boolean {
  if (!isFullTerminal()) return false;
  if (event.type === "terminal_frame") {
    const part = event.terminalFrame;
    if (!part || !bridgeId || part.terminalId !== bridgeId || bridgePane !== openPaneId()) return true;
    try {
      fullTerminalPerf.framePart(part.data.byteLength);
      const assembledAt = performance.now();
      const frame = assembler.push(part);
      if (!frame) return true;
      const commandMarker = fullTerminalPerf.frameAssembled(performance.now() - assembledAt);
      const sequence = BigInt(frame.sequence);
      const admission = frameGate.preflight(sequence, frame.full);
      if (admission === "stale") return true;
      if (admission === "gap") {
        void suspendBridge(true, copy("ft.gap"));
        return true;
      }
      if (pendingWriteBytes + frame.data.byteLength > MAX_RENDER_QUEUE_BYTES) {
        void suspendBridge(true, copy("ft.tooFast"));
        return true;
      }
      const nextRemote = { cols: frame.width, rows: frame.height };
      const remoteChanged = !remoteGrid || remoteGrid.cols !== nextRemote.cols || remoteGrid.rows !== nextRemote.rows;
      remoteGrid = nextRemote;
      if (remoteChanged) requestResize(fit(), nextRemote);
      const writer = terminal;
      if (frameGate.settle(sequence, frame.full, Boolean(writer && frameMatchesGrid(frame, writer))) === "wait") return true;
      if (frame.full) writer?.reset();
      if (writer) {
        const writeVersion = bridgeVersion;
        const writeStartedAt = performance.now();
        pendingWriteBytes += frame.data.byteLength;
        fullTerminalPerf.writeStarted(frame.data.byteLength, pendingWriteBytes);
        writer.write(frame.data, () => {
          // The frame may have left the cursor under what covers the last rows, or back above it.
          if (terminal === writer) followCursor(writer.element?.parentElement ?? null, writer);
          if (terminal === writer && bridgeVersion === writeVersion) {
            pendingWriteBytes = Math.max(0, pendingWriteBytes - frame.data.byteLength);
            fullTerminalPerf.writeCompleted(performance.now() - writeStartedAt, commandMarker);
            terminalRecovery?.firstFrame();
          }
        });
      }
      terminalStatus.set(copy("ft.live"), "live");
    } catch (error) {
      void suspendBridge(true, messageCopy(error));
    }
    return true;
  }
  if (event.type === "terminal_closed") {
    if (event.terminalId !== bridgeId) return true;
    stopCommandPump();
    bridgeId = "";
    bridgePane = "";
    bridgeVersion++;
    opening = false;
    assembler.reset();
    frameGate.reset();
    pendingWriteBytes = 0;
    remoteGrid = null;
    fullTerminalPerf.publish("terminal_closed");
    terminalStatus.fail(event.reason ? copy("ft.closedReason", { reason: event.reason }) : copy("ft.closed"));
    return true;
  }
  if (event.type === "disconnected" || event.type === "reconnecting" || event.type === "terminal") {
    stopCommandPump();
    bridgeId = "";
    bridgePane = "";
    bridgeVersion++;
    opening = false;
    assembler.reset();
    frameGate.reset();
    pendingWriteBytes = 0;
    remoteGrid = null;
    fullTerminalPerf.publish(event.type);
    terminalStatus.wait(copy("ft.waitRestore"));
    return false;
  }
  if (event.type === "connected" && !bridgeId) {
    terminalStatus.set(copy("ft.restored"), "opening");
    void resumeFullTerminal();
  }
  return false;
}

export function handleFullTerminalVisibility(hidden: boolean): void {
  if (!isFullTerminal()) return;
  if (hidden) void suspendBridge(true);
  else void resumeFullTerminal();
}

connectFullTerminalEngine({
  scheduleMount,
  disposeRenderer,
  releaseBridge: () => void suspendBridge(true, undefined, false),
  rendererBusy: () => Boolean(terminal || mounting || cancelMount),
  setShellActive: (active) => {
    terminalShellActive = active;
    setFullTerminalDocumentMode(active);
  },
});

export { attachFullTerminalHost };
export { FullTerminalScreen, releaseFullTerminalScreen } from "./full-terminal-screen";
export { getFullTerminalView, subscribeFullTerminalView } from "./full-terminal-view";

/** Read the displayed renderer, never the guided-mode snapshot cache. */
export function fullTerminalScreenText(paneId: string): string {
  if (!isFullTerminal() || bridgePane !== paneId || openPaneId() !== paneId || !terminal) return "";
  return terminalScreenText(terminal);
}
