import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { agentTitle } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { backButton } from "./chrome";
import {
  ProtocolError,
  TerminalFrameAssembler,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  type SessionEvent,
} from "../lib/protocol/client";
import { render } from "../paint";
import { app, haptic, messageOf, saveTermFit, selectedAgent, setPaneTermMode, state, type TermFit } from "../state";
import { isDesk } from "../viewport";
import {
  bindFontPinch,
  clearScreenScale,
  cssCellOf,
  displayGrid,
  FULL_TERM_FONT_FAMILY,
  hostInnerSize,
  integerizeDomRows,
  measureGlyphHeight,
  paintedFontSize,
  pickFontSize,
  pitchLineHeight,
  probePanCanvas,
  ptyCols,
  sizePanCanvas,
  snapCellLineHeight,
  visualCells,
} from "./full-terminal-fit";
import {
  bindXtermKeyboard,
  encodeTerminalKey,
  fullTerminalPad,
  httpLinkProvider,
  syncKeyboardButton,
  terminalLinkHandler,
  type TerminalKeyboard,
} from "./full-terminal-input";
import { bindHostScroll, pageLineCount, scrollRail, type ScrollAt } from "./full-terminal-scroll";
import { TerminalCommandPump, type TerminalCommand } from "./full-terminal-command";
import { fullTerminalPerf } from "./full-terminal-perf";
import { track } from "../lib/telemetry";
import { chromeActionCluster, syncChromeStop } from "./session/chrome-actions";
import { guidedScrollController } from "./session/guided-scroll";

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let unbindScroll: (() => void) | null = null;
let unbindPinch: (() => void) | null = null;
let keyboard: TerminalKeyboard | null = null;
let lockedFont: number | null = null;
let fitting = false;
let pinchResizeTimer = 0;
let mounting = false;
let rendererVersion = 0;
let bridgeId = "";
let bridgePane = "";
let bridgeVersion = 0;
let opening = false;
let leaving: Promise<void> | null = null;
let leaveSeq = 0;
let commandPump: TerminalCommandPump | null = null;
let statusText = "正在打开终端…";
let retryAvailable = false;
let lastFrameSequence: bigint | null = null;
let pendingWriteBytes = 0;
/** Last terminal.frame grid. Display clamps to this so a short PTY can scale-fill. */
let remoteGrid: { cols: number; rows: number } | null = null;
/** Size we keep asking Herdr for, even when display is smaller than the PTY. */
let fittedSize: { cols: number; rows: number; cellWidth: number; cellHeight: number } | null = null;
const assembler = new TerminalFrameAssembler();
const MAX_RENDER_QUEUE_BYTES = 8 * 1024 * 1024;
const FULL_TERMINAL_DOCUMENT_CLASS = "full-terminal-active";

function setFullTerminalDocumentMode(active: boolean): void {
  document.documentElement.classList.toggle(FULL_TERMINAL_DOCUMENT_CLASS, active);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function statusElement(): HTMLElement | null {
  return app.querySelector(".full-terminal-status");
}

function retryElement(): HTMLButtonElement | null {
  return app.querySelector(".full-terminal-retry");
}

function syncRetry(): void {
  const retry = retryElement();
  if (retry) retry.hidden = !state.fullTerminal || !retryAvailable || opening || Boolean(bridgeId);
}

function setStatus(text: string): void {
  statusText = text;
  const status = statusElement();
  if (status) status.textContent = text;
  syncRetry();
}

function offerRetry(text: string): void {
  retryAvailable = true;
  setStatus(text);
}

function measureCellWidth(fontSize: number): number {
  if (!terminal) return fontSize * 0.6;
  if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize;
  return cssCellOf(terminal)?.width || fontSize * 0.6;
}

function liveSize(cols: number, rows: number): { cols: number; rows: number; cellWidth: number; cellHeight: number } {
  const host = app.querySelector(".full-terminal-host") as HTMLElement | null;
  const visual = host ? visualCells(host, cols, rows) : { width: 0, height: 0 };
  const measured = terminal ? cssCellOf(terminal) : null;
  return {
    cols,
    rows,
    cellWidth: visual.width || Math.round(measured?.width || 0),
    cellHeight: visual.height || Math.round(measured?.height || 0),
  };
}

function panCanvas(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".full-terminal-canvas") as HTMLElement | null;
}

function terminalMount(host: HTMLElement): HTMLElement {
  return panCanvas(host) ?? host;
}

function fit(): { cols: number; rows: number; cellWidth: number; cellHeight: number } {
  const fallback = { cols: 80, rows: 24, cellWidth: 0, cellHeight: 0 };
  const host = app.querySelector(".full-terminal-host") as HTMLElement | null;
  if (!terminal || !fitAddon || !host) return fallback;
  if (fitting) return fittedSize ?? liveSize(terminal.cols || 80, terminal.rows || 24);
  fitting = true;
  try {
    const inner = hostInnerSize(host);
    if (inner.width < 8 || inner.height < 8) return fallback;
    const canvas = panCanvas(host);
    const pan = state.termFit === "pan";
    host.classList.toggle("is-pan", pan);
    probePanCanvas(canvas, inner.width);
    let font = pickFontSize({
      hostWidth: inner.width,
      cellWidthAt: measureCellWidth,
      preferred: lockedFont ?? state.termFontPx,
      locked: lockedFont !== null || pan,
    });
    terminal.options.fontSize = font;
    try {
      fitAddon.fit();
    } catch {
      /* probe paint size */
    }
    const painted = paintedFontSize(host, font);
    if (painted > font) {
      font = painted;
      terminal.options.fontSize = font;
    }
    const dpr = window.devicePixelRatio || 1;
    const glyphHeight = measureGlyphHeight(FULL_TERM_FONT_FAMILY, font);
    const rowsGuess = clamp(
      Math.floor(inner.height / Math.max(1, font * 1.5)),
      TERMINAL_MIN_ROWS,
      TERMINAL_MAX_ROWS,
    );
    terminal.options.fontSize = font;
    terminal.options.lineHeight = pitchLineHeight(font, glyphHeight, dpr, rowsGuess);
    terminal.options.letterSpacing = 0;
    try {
      fitAddon.fit();
    } catch {
      // A hidden page can briefly report a zero-sized host. The next observer
      // callback or pageshow will fit again.
    }
    const cell = cssCellOf(terminal);
    const visibleCols = clamp(
      cell ? Math.floor(inner.width / cell.width) : terminal.cols || 80,
      TERMINAL_MIN_COLS,
      TERMINAL_MAX_COLS,
    );
    const cols = clamp(ptyCols(visibleCols, state.termFit), TERMINAL_MIN_COLS, TERMINAL_MAX_COLS);
    const rows = clamp(
      cell ? Math.floor(inner.height / cell.height) : terminal.rows || 24,
      TERMINAL_MIN_ROWS,
      TERMINAL_MAX_ROWS,
    );
    const display = displayGrid({ cols, rows }, remoteGrid);
    const pitched = pitchLineHeight(font, glyphHeight, dpr, display.rows);
    if (Math.abs(pitched - (terminal.options.lineHeight || 0)) > 0.001) {
      terminal.options.lineHeight = pitched;
    }
    const used = cssCellOf(terminal);
    if (used) {
      const snapped = snapCellLineHeight(terminal.options.lineHeight || pitched, used.height);
      if (Math.abs(snapped - (terminal.options.lineHeight || 0)) > 0.001) {
        terminal.options.lineHeight = snapped;
      }
    }
    if (terminal.cols !== display.cols || terminal.rows !== display.rows) {
      terminal.resize(display.cols, display.rows);
    }
    clearScreenScale(host);
    const measured = cssCellOf(terminal) || cell;
    const visual = liveSize(display.cols, display.rows);
    fittedSize = {
      cols,
      rows,
      cellWidth: Math.max(1, Math.round(measured?.width || visual.cellWidth)),
      cellHeight: Math.max(1, Math.round(measured?.height || visual.cellHeight)),
    };
    sizePanCanvas(canvas, pan, display.cols, measured?.width || fittedSize.cellWidth, inner.width);
    integerizeDomRows(host, fittedSize.cellHeight);
    return fittedSize;
  } finally {
    fitting = false;
  }
}

function stopCommandPump(): void {
  commandPump?.stop();
  commandPump = null;
}

function startCommandPump(
  session: NonNullable<typeof state.live>,
  terminalId: string,
  version: number,
): void {
  stopCommandPump();
  const execute = (command: TerminalCommand, sequence: number): Promise<unknown> => {
    if (version !== bridgeVersion || bridgeId !== terminalId || state.live !== session || !state.fullTerminal) {
      return Promise.reject(new ProtocolError("conflict", "终端控制器已经切换"));
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
      void suspendBridge(true, `控制中断：${messageOf(error)}`);
    },
  });
}

function sendInput(data: Uint8Array): void {
  commandPump?.enqueueInput(data);
}

function cellAt(clientX: number, clientY: number): ScrollAt | undefined {
  const host = app.querySelector(".full-terminal-host") as HTMLElement | null;
  if (!terminal || !host) return;
  const cols = terminal.cols || 80;
  const rows = terminal.rows || 24;
  const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
  const rect = (screen ?? host).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  return {
    column: clamp(Math.floor((clientX - rect.left) / (rect.width / cols)), 0, cols - 1),
    row: clamp(Math.floor((clientY - rect.top) / (rect.height / rows)), 0, rows - 1),
  };
}

function closeTerminalKeyboard(): void {
  keyboard?.close();
  syncKeyboardButton(app, keyboard?.isOpen() === true);
}

function sendScroll(direction: "up" | "down", lines: number, source: "wheel" | "page_key", at?: ScrollAt): void {
  closeTerminalKeyboard();
  if (!bridgeId || opening || !commandPump) return;
  const count = clamp(Math.round(lines), 1, TERMINAL_MAX_ROWS);
  commandPump.enqueueScroll({ direction, lines: count, source, at });
}

function pageScrollLines(): number {
  return clamp(pageLineCount(terminal?.rows || fittedSize?.rows || 24), 1, TERMINAL_MAX_ROWS);
}

function sendPadKey(key: string): void {
  if (!terminal || !bridgeId || opening) return;
  const bytes = encodeTerminalKey(key, terminal.modes.applicationCursorKeysMode);
  if (!bytes) return;
  haptic(4);
  terminal.input(bytes);
}

function bindInput(host: HTMLElement): void {
  if (!terminal) return;
  terminal.onData((value) => sendInput(new TextEncoder().encode(value)));
  terminal.onBinary((value) => {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index) & 0xff;
    sendInput(bytes);
  });
  terminal.onResize(() => {
    if (!bridgeId || opening || fitting || !commandPump || !fittedSize) return;
    commandPump.enqueueResize({
      cols: fittedSize.cols,
      rows: fittedSize.rows,
      cellWidth: fittedSize.cellWidth,
      cellHeight: fittedSize.cellHeight,
    });
  });
  unbindScroll?.();
  unbindScroll = bindHostScroll(host, sendScroll, cellAt, {
    nativePanX: () => state.termFit === "pan",
  });
  unbindPinch?.();
  unbindPinch = bindFontPinch(
    host,
    () => lockedFont ?? terminal?.options.fontSize ?? state.termFontPx,
    (px) => {
      lockedFont = px;
      fit();
      window.clearTimeout(pinchResizeTimer);
      pinchResizeTimer = window.setTimeout(() => {
        if (!bridgeId || opening || !terminal || !commandPump) return;
        const size = liveSize(terminal.cols || 80, terminal.rows || 24);
        commandPump.enqueueResize({
          cols: size.cols,
          rows: size.rows,
          cellWidth: size.cellWidth,
          cellHeight: size.cellHeight,
        });
      }, 120);
    },
  );
  keyboard = bindXtermKeyboard(host, isDesk());
}

async function mount(host: HTMLElement): Promise<void> {
  const version = ++rendererVersion;
  mounting = true;
  retryAvailable = false;
  let module: typeof import("./full-terminal-xterm.ts");
  try {
    module = await import("./full-terminal-xterm.ts");
  } catch (error) {
    if (version !== rendererVersion) return;
    mounting = false;
    offerRetry(`终端组件加载失败：${messageOf(error)}`);
    return;
  }
  if (version !== rendererVersion || !state.fullTerminal || !host.isConnected) return;
  mounting = false;
  terminal = new module.Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    convertEol: false,
    disableStdin: false,
    drawBoldTextInBrightColors: true,
    customGlyphs: true,
    fontFamily: FULL_TERM_FONT_FAMILY,
    fontSize: state.termFontPx,
    lineHeight: pitchLineHeight(
      state.termFontPx,
      measureGlyphHeight(FULL_TERM_FONT_FAMILY, state.termFontPx),
      window.devicePixelRatio || 1,
      24,
    ),
    letterSpacing: 0,
    scrollback: 0,
    linkHandler: terminalLinkHandler(),
    theme: {
      background: "#090c10",
      foreground: "#e7ebf1",
      cursor: "#8ab4ff",
      cursorAccent: "#090c10",
      selectionBackground: "#305a8a99",
    },
  });
  fitAddon = new module.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalMount(host));
  fullTerminalPerf.componentReady();
  terminal.registerLinkProvider(httpLinkProvider(terminal));
  bindInput(host);
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      const previousCols = terminal?.cols;
      const previousRows = terminal?.rows;
      const size = fit();
      if (!bridgeId || opening || !commandPump || (size.cols === previousCols && size.rows === previousRows)) return;
      commandPump.enqueueResize({
        cols: size.cols,
        rows: size.rows,
        cellWidth: size.cellWidth,
        cellHeight: size.cellHeight,
      });
    });
    resizeObserver.observe(host);
  }
  const start = async () => {
    try {
      await document.fonts?.ready;
    } catch {
      /* system fonts; a missing FontFaceSet must not block the bridge */
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (version !== rendererVersion || !host.isConnected) return;
    fit();
    if (isDesk()) terminal?.focus();
    else closeTerminalKeyboard();
    void openBridge(false);
  };
  void start();
}

function disposeRenderer(): void {
  rendererVersion++;
  mounting = false;
  stopCommandPump();
  unbindScroll?.();
  unbindScroll = null;
  unbindPinch?.();
  unbindPinch = null;
  lockedFont = null;
  fitting = false;
  remoteGrid = null;
  fittedSize = null;
  window.clearTimeout(pinchResizeTimer);
  pinchResizeTimer = 0;
  keyboard = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
  assembler.reset();
  lastFrameSequence = null;
  pendingWriteBytes = 0;
}

async function openBridge(takeover: boolean): Promise<void> {
  const session = state.live;
  const paneId = state.paneId;
  if (opening || bridgeId || !session || !paneId || !state.fullTerminal || document.visibilityState === "hidden") return;
  const version = bridgeVersion;
  opening = true;
  retryAvailable = false;
  setStatus(takeover ? "正在接管终端…" : "正在打开终端…");
  fullTerminalPerf.bridgeStarted();
  try {
    const size = fit();
    const opened = await session.terminalOpen(paneId, size.cols, size.rows, takeover);
    if (version !== bridgeVersion || !state.fullTerminal || state.live !== session || state.paneId !== paneId) {
      await session.terminalClose(opened.terminalId).catch(() => undefined);
      return;
    }
    bridgeId = opened.terminalId;
    bridgePane = paneId;
    startCommandPump(session, opened.terminalId, version);
    fullTerminalPerf.bridgeOpened();
    assembler.reset();
    lastFrameSequence = null;
    retryAvailable = false;
    setStatus("实时 · 端到端加密");
    if (isDesk() || keyboard?.isOpen()) terminal?.focus();
    else closeTerminalKeyboard();
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "conflict" && !takeover
      && window.confirm("另一个终端客户端正在控制这个 pane。要从这里接管输入和窗口大小吗？")) {
      opening = false;
      await openBridge(true);
      return;
    }
    offerRetry(`无法打开终端：${messageOf(error)}`);
  } finally {
    if (version === bridgeVersion) {
      opening = false;
      setStatus(statusText);
    }
  }
}

async function suspendBridge(sendClose: boolean, reason = "终端连接已暂停"): Promise<void> {
  const session = state.live;
  const id = bridgeId;
  stopCommandPump();
  bridgeVersion++;
  bridgeId = "";
  bridgePane = "";
  assembler.reset();
  lastFrameSequence = null;
  pendingWriteBytes = 0;
  remoteGrid = null;
  opening = false;
  if (sendClose && session && id) await session.terminalClose(id).catch(() => undefined);
  offerRetry(reason);
}

export function retryFullTerminal(): void {
  if (opening || bridgeId) return;
  haptic(8);
  retryAvailable = false;
  setStatus("正在打开终端…");
  const host = app.querySelector(".full-terminal-host") as HTMLElement | null;
  if (!terminal && host?.isConnected) {
    void mount(host);
    return;
  }
  void openBridge(false);
}

export function setTermFit(next: TermFit): void {
  if (state.termFit === next) return;
  state.termFit = next;
  saveTermFit();
  const host = app.querySelector(".full-terminal-host") as HTMLElement | null;
  host?.classList.toggle("is-pan", next === "pan");
  if (next !== "pan") {
    const scroller = host?.querySelector(".full-terminal-pan");
    if (scroller instanceof HTMLElement) scroller.scrollLeft = 0;
  }
  if (!state.fullTerminal || !terminal) return;
  const previous = fittedSize;
  const size = fit();
  if (!bridgeId || opening || !commandPump) return;
  if (previous && size.cols === previous.cols && size.rows === previous.rows) return;
  commandPump.enqueueResize({
    cols: size.cols,
    rows: size.rows,
    cellWidth: size.cellWidth,
    cellHeight: size.cellHeight,
  });
}

export function enterFullTerminal(): void {
  if (!state.live || !state.paneId || state.fullTerminal) return;
  guidedScrollController.dispose();
  haptic(8);
  track("pwa_terminal");
  setPaneTermMode(state.paneId, "full");
  state.agentChat = false;
  state.fullTerminal = true;
  retryAvailable = false;
  statusText = "正在打开终端…";
  render();
}

export function leaveFullTerminal(opts?: { rememberGuided?: boolean; paint?: boolean }): Promise<void> {
  if (leaving) return leaving;
  if (!state.fullTerminal) return Promise.resolve();
  const seq = ++leaveSeq;
  const rememberGuided = opts?.rememberGuided !== false;
  const paint = opts?.paint !== false;
  leaving = (async () => {
    try {
      await suspendBridge(true);
      if (seq !== leaveSeq) return;
      disposeRenderer();
      fullTerminalPerf.publish("leave");
      if (rememberGuided) setPaneTermMode(state.paneId, "guided");
      state.fullTerminal = false;
      setFullTerminalDocumentMode(false);
      if (paint) render();
    } finally {
      if (seq === leaveSeq) leaving = null;
    }
  })();
  return leaving;
}

export function disposeFullTerminal(): void {
  leaveSeq++;
  leaving = null;
  state.fullTerminal = false;
  setFullTerminalDocumentMode(false);
  retryAvailable = false;
  bridgeId = "";
  bridgePane = "";
  stopCommandPump();
  bridgeVersion++;
  opening = false;
  disposeRenderer();
}

function interruptFullTerminal(): void {
  sendPadKey("esc");
}

function syncFullTerminalChrome(): void {
  const chrome = app.querySelector(".full-terminal-chrome");
  if (!(chrome instanceof HTMLElement)) return;
  syncChromeStop(chrome, selectedAgent()?.status === "working", interruptFullTerminal);
  syncRetry();
}

export function renderFullTerminal(onBack: () => void, onMenu: () => void): void {
  setFullTerminalDocumentMode(true);
  const mounted = app.querySelector(".full-terminal-root");
  if (mounted) {
    const title = app.querySelector(".full-terminal-title");
    if (title) title.textContent = selectedAgent() ? agentTitle(selectedAgent()!) : "终端";
    setStatus(statusText);
    syncFullTerminalChrome();
    return;
  }
  disposeRenderer();
  fullTerminalPerf.begin();
  const root = node("div", "pane-root full-terminal-root");
  const chrome = node("header", "chrome full-terminal-chrome");
  const back = backButton(onBack, "返回会话列表");
  const titleWrap = node("div", "full-terminal-heading");
  titleWrap.append(
    node("strong", "full-terminal-title", selectedAgent() ? agentTitle(selectedAgent()!) : "终端"),
    node("span", "full-terminal-status", statusText),
  );
  chrome.append(back, titleWrap, chromeActionCluster(onMenu));
  syncFullTerminalChrome();
  const host = node("div", "full-terminal-host");
  host.setAttribute("aria-label", "终端");
  if (state.termFit === "pan") host.classList.add("is-pan");
  const pan = node("div", "full-terminal-pan");
  pan.append(node("div", "full-terminal-canvas"));
  host.append(scrollRail(
    (direction, lines, source) => {
      haptic(4);
      sendScroll(direction, lines, source);
    },
    pageScrollLines,
  ), pan);
  root.append(chrome, host, fullTerminalPad(sendPadKey, {
    toggle: () => {
      if (!keyboard) keyboard = bindXtermKeyboard(host, false);
      keyboard.toggle();
    },
    isOpen: () => keyboard?.isOpen() === true,
  }));
  app.replaceChildren(root);
  void mount(host);
}

export function handleFullTerminalEvent(event: SessionEvent): boolean {
  if (!state.fullTerminal) return false;
  if (event.type === "terminal_frame") {
    const part = event.terminalFrame;
    if (!part || !bridgeId || part.terminalId !== bridgeId || bridgePane !== state.paneId) return true;
    try {
      fullTerminalPerf.framePart(part.data.byteLength);
      const assembledAt = performance.now();
      const frame = assembler.push(part);
      if (!frame) return true;
      fullTerminalPerf.frameAssembled(performance.now() - assembledAt);
      const sequence = BigInt(frame.sequence);
      if (!frame.full && lastFrameSequence !== null && sequence !== lastFrameSequence + 1n) {
        void suspendBridge(true, "终端画面出现缺口，请点重连");
        return true;
      }
      if (lastFrameSequence !== null && sequence <= lastFrameSequence) return true;
      if (pendingWriteBytes + frame.data.byteLength > MAX_RENDER_QUEUE_BYTES) {
        void suspendBridge(true, "终端输出过快，请点重连");
        return true;
      }
      if (frame.full) terminal?.reset();
      const nextRemote = { cols: frame.width, rows: frame.height };
      const remoteChanged = !remoteGrid || remoteGrid.cols !== nextRemote.cols || remoteGrid.rows !== nextRemote.rows;
      remoteGrid = nextRemote;
      if (remoteChanged) {
        const size = fit();
        if (bridgeId && !opening && commandPump) {
          commandPump.enqueueResize({
            cols: size.cols,
            rows: size.rows,
            cellWidth: size.cellWidth,
            cellHeight: size.cellHeight,
          });
        }
      }
      const writer = terminal;
      if (writer) {
        const writeVersion = bridgeVersion;
        const writeStartedAt = performance.now();
        pendingWriteBytes += frame.data.byteLength;
        fullTerminalPerf.writeStarted(frame.data.byteLength, pendingWriteBytes);
        writer.write(frame.data, () => {
          if (terminal === writer && bridgeVersion === writeVersion) {
            pendingWriteBytes = Math.max(0, pendingWriteBytes - frame.data.byteLength);
            fullTerminalPerf.writeCompleted(performance.now() - writeStartedAt);
          }
        });
      }
      lastFrameSequence = sequence;
      setStatus("实时 · 端到端加密");
    } catch (error) {
      void suspendBridge(true, messageOf(error));
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
    lastFrameSequence = null;
    pendingWriteBytes = 0;
    remoteGrid = null;
    fullTerminalPerf.publish("terminal_closed");
    offerRetry(event.reason ? `终端已关闭：${event.reason}` : "终端已关闭");
    return true;
  }
  if (event.type === "disconnected" || event.type === "reconnecting" || event.type === "terminal") {
    stopCommandPump();
    bridgeId = "";
    bridgePane = "";
    bridgeVersion++;
    opening = false;
    assembler.reset();
    lastFrameSequence = null;
    pendingWriteBytes = 0;
    remoteGrid = null;
    fullTerminalPerf.publish(event.type);
    offerRetry("连接中断，等待恢复…");
    return false;
  }
  if (event.type === "connected" && !bridgeId) {
    setStatus("连接已恢复，正在重开终端…");
    void openBridge(false);
  }
  return false;
}

export function handleFullTerminalVisibility(hidden: boolean): void {
  if (!state.fullTerminal) return;
  if (hidden) void suspendBridge(true);
  else if (!bridgeId) {
    fit();
    void openBridge(false);
  }
}
