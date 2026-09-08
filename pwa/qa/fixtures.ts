import { app, state } from "../src/state";
import { setRenderer } from "../src/paint";
import { setLang, lang, applyDocumentLang } from "../src/lib/i18n";
import { setTelemetrySender, resetTelemetry } from "../src/lib/telemetry";
import { bindRippleSurface } from "../src/lib/dom";
import { bindLegacyGestureBoundary } from "../src/lib/gesture-boundary";
import { applyVisualViewport, bindVisualViewport } from "../src/viewport";
import { initSwipeBack } from "../src/ui/pane";
import { dropQueuedKeys } from "../src/ui/session/keys";
import { handlePaneKey, revealCaretRow, stickBottom } from "../src/ui/session-view";
import { stickAgentStream } from "../src/ui/agent-chat";
import { guidedScrollController } from "../src/ui/session/guided-scroll";
import { disposeFullTerminal, handleFullTerminalEvent, handleFullTerminalVisibility } from "../src/ui/full-terminal";
import { releaseBoardScroll } from "../src/ui/board-canvas";
import { clearWorkspacePendingReveal, leaveWorkspace } from "../src/workspace";
import { scenes, applyScene, afterScenePaint, resetFixtureState } from "./scenes";
import { createSession, type FixtureSession } from "./session";
import { calls, errors, record, settlePaint } from "./environment";
import type { FixtureAPI, FixtureMode, FixtureRect, FixtureSnapshot } from "./types";

const RECT_SELECTORS = ["#app", ".page", ".boot", ".chrome", ".rail", ".main", ".pane-root", ".term-wrap", ".term", ".dock",
  ".keys", ".agent-stream", ".agent-dock", ".workspace-shell", ".workspace-nav", ".workspace-main", ".workspace-diff",
  ".board-viewport", ".board-stage", ".board-pane", ".full-terminal-host", ".full-terminal-pad", "dialog[open]"];
const nodeIds = new WeakMap<Node, number>();
let nodeSerial = 0;
function nodeId(node: Node): number { let id = nodeIds.get(node); if (!id) { id = ++nodeSerial; nodeIds.set(node, id); } return id; }
function rect(element: Element): FixtureRect {
  const r = element.getBoundingClientRect();
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
}
const isReactElement = (element: Element) => Object.keys(element).some((key) => key.startsWith("__reactFiber$"));

export async function createFixtureAPI(mode: FixtureMode, language: "zh" | "en", initialScene: string): Promise<FixtureAPI> {
  let currentScene = initialScene;
  let ready = false;
  let preparing = false;
  let session: FixtureSession | undefined;
  let serial: Promise<unknown> = Promise.resolve();
  let react: { renderReactFixture(): void; resetReactFixture(): void; renderReactTerminalShell(error: boolean): void } | undefined;
  let baseline: { renderBaselineFixture(): void; renderTerminalShell(error: boolean): void } | undefined;
  if (mode === "react") {
    // Vite must not resolve the React branch when this folder is copied to an immutable baseline.
    const entry = "/qa/react-entry.ts";
    react = await import(/* @vite-ignore */ entry);
  } else {
    // This adapter resolves old UI APIs only in the immutable reference checkout.
    const entry = "/qa/baseline.ts";
    baseline = await import(/* @vite-ignore */ entry);
  }
  setLang(language);
  applyDocumentLang();
  setTelemetrySender((body) => record("lifecycle", "telemetry", [JSON.parse(body)]));
  bindRippleSurface(document);
  bindLegacyGestureBoundary(document);
  initSwipeBack();
  document.addEventListener("visibilitychange", () => handleFullTerminalVisibility(document.visibilityState === "hidden"));
  document.addEventListener("keydown", (event) => {
    if (state.phase !== "live" || state.screen !== "pane" || state.termSelect || state.fullTerminal || state.agentChat || event.defaultPrevented) return;
    if (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, select, summary, dialog, [role='button'], [contenteditable='true']")) return;
    handlePaneKey(event, false);
  });
  const paint = () => {
    if (preparing) return;
    if (scenes.find((scene) => scene.name === currentScene)?.shellOnly && state.fullTerminal) {
      if (react) react.renderReactTerminalShell(currentScene === "terminal-error");
      else baseline!.renderTerminalShell(currentScene === "terminal-error");
    } else if (react) react.renderReactFixture();
    else baseline!.renderBaselineFixture();
    applyVisualViewport();
  };
  setRenderer(paint);
  // Match main.ts: focusing an editable field adjusts scrolling, never rebuilds it.
  bindVisualViewport(() => {
    if (state.phase !== "live" || state.screen !== "pane" || state.fullTerminal) return;
    requestAnimationFrame(() => {
      if (state.agentChat) stickAgentStream();
      else if (state.paneFollow) stickBottom();
    });
  }, open => {
    if (!open || state.phase !== "live" || state.screen !== "pane" || state.fullTerminal || state.agentChat) return;
    requestAnimationFrame(revealCaretRow);
  });
  window.matchMedia("(min-width: 900px)").addEventListener("change", paint);

  const snapshot = (): FixtureSnapshot => {
    const elements = [...app.querySelectorAll("*")];
    const reactElements = elements.filter(isReactElement).length;
    const rects = Object.fromEntries(RECT_SELECTORS.map((selector) => [selector, [...document.querySelectorAll(selector)].map(rect)]));
    const inputs = [...app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].map((input) => ({
      nodeId: nodeId(input), selector: input.id ? `#${input.id}` : `${input.tagName.toLowerCase()}.${input.className}`,
      value: input.value, focused: document.activeElement === input,
      selection: [input.selectionStart, input.selectionEnd] as [number | null, number | null],
    }));
    return { scene: currentScene, mode, ready, shellOnly: !!scenes.find((scene) => scene.name === currentScene)?.shellOnly,
      reactOwned: [...app.children].some(isReactElement), reactElements,
      viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale ?? 1 },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: lang(),
      appClass: app.className, bodyClass: document.body.className, rootClass: document.documentElement.className,
      phase: state.phase, screen: state.screen,
      overflow: { documentX: Math.max(0, document.documentElement.scrollWidth - innerWidth), appX: Math.max(0, app.scrollWidth - app.clientWidth) },
      rects, inputs, calls: structuredClone(calls), errors: [...errors] };
  };
  const select = async (name: string): Promise<FixtureSnapshot> => {
    if (!scenes.some((scene) => scene.name === name)) throw new Error(`Unknown QA scene: ${name}`);
    preparing = true;
    ready = false;
    document.documentElement.dataset.qaReady = "false";
    setRenderer(() => undefined);
    if (state.screen === "workspace") leaveWorkspace();
    clearWorkspacePendingReveal();
    dropQueuedKeys();
    guidedScrollController.dispose();
    releaseBoardScroll();
    disposeFullTerminal();
    resetTelemetry();
    for (const dialog of document.querySelectorAll("dialog")) { if (dialog.open) dialog.close(); dialog.remove(); }
    react?.resetReactFixture();
    app.replaceChildren();
    session?.dispose();
    session = createSession();
    session.live.onEvent(handleFullTerminalEvent);
    currentScene = name;
    calls.length = 0;
    errors.length = 0;
    resetFixtureState(session);
    try {
      await applyScene(name, session);
    } finally {
      preparing = false;
      setRenderer(paint);
    }
    window.scrollTo(0, 0);
    paint();
    await settlePaint();
    afterScenePaint(name);
    await settlePaint();
    ready = true;
    document.documentElement.dataset.qaReady = "true";
    document.documentElement.dataset.qaScene = name;
    return snapshot();
  };
  const api: FixtureAPI = {
    mode, scenes, ready: Promise.resolve(), state, calls,
    setScene(name) {
      const next = serial.then(() => select(name));
      serial = next.catch(() => undefined);
      return next;
    },
    async setLanguage(value) { setLang(value); applyDocumentLang(); return api.setScene(currentScene); },
    async render() { paint(); await settlePaint(); return snapshot(); },
    snapshot,
    clearCalls() { calls.length = 0; },
    setConnected(value) { session?.setConnected(value); state.networkOnline = value; paint(); },
    emit(event) { session?.emit(event); },
    terminalFrame(text, options) { return session?.terminalFrame(text, options) ?? false; },
    hold(method) { session?.hold(method); },
    release(method) { session?.release(method); },
    failNext(method, code) { session?.failNext(method, code); },
  };
  api.ready = api.setScene(initialScene).then(() => undefined);
  return api;
}
