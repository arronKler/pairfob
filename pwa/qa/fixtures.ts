import { setLang, lang, applyDocumentLang } from "../src/lib/i18n";
import { setTelemetrySender, resetTelemetry } from "../src/lib/telemetry";
import { bindRippleSurface } from "../src/lib/dom";
import { bindLegacyGestureBoundary } from "../src/lib/gesture-boundary";
import { commitView } from "../src/app/host";
import { mountApp, unmountApp, isAppMounted } from "../src/app/mount";
import { registerSessionOwnerPreparer, sessionOwnerPreparer } from "../src/app/frame";
import { registerSessionView } from "../src/features/session/register";
import { bindVisualViewport, applyVisualViewport } from "../src/app/viewport";
import { initSwipeBack } from "../src/features/session/pane-actions";
import { dropQueuedKeys } from "../src/features/session/guided/keys";
import { handlePaneKey } from "../src/features/session/guided/compose";
import { revealCaretRow, stickBottom } from "../src/features/session/guided/term";
import { stickAgentStream } from "../src/features/session/chat/agent-chat-controller";
import { guidedScrollController } from "../src/features/session/guided/guided-scroll";
import {
  disposeFullTerminal, getFullTerminalView, handleFullTerminalEvent, handleFullTerminalVisibility,
} from "../src/features/session/full-terminal/full-terminal";
import { releaseBoardScroll } from "../src/pages/board/pane-scroll";
import { phase, setNetworkOnline } from "../src/features/connection/connection-store";
import { currentScreen } from "../src/app/navigation-store";
import { isAgentChat, isFullTerminal, paneFollow, termSelect } from "../src/features/session/session-store";
import { scenes, resetFixtureBaseline, applyScene, afterScenePaint } from "./scenes";
import { createSession, type FixtureSession } from "./session";
import { renderTerminalShell, disposeTerminalShell } from "./terminal-shell";
import { calls, errors, record, settlePaint } from "./environment";
import type { FixtureAPI, FixtureRect, FixtureSnapshot, FixtureTerminalFrame, FixtureMode } from "./types";

/**
 * QA fixture orchestrator.
 *
 * The fixture drives the SAME stable production App (`app/mount.tsx`) with the
 * production session-owner seam (`features/session/register`) and explicit
 * browser adapters. There is no paint wrapper, no duplicate shell orchestrator
 * and no second page root: a scene reset names the fixture baseline through
 * typed domain actions, then the fixture commits once and the App composes the
 * page from the prepared frame. Only the two deliberate shell-only terminal
 * scenes run the QA FullTerminalScreen shell fixture with the App unmounted.
 *
 * Listeners are bound once and explicitly released on page unload, so switching
 * scenes or reloading never accumulates handlers.
 */

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

export async function createFixtureAPI(language: "zh" | "en", initialScene: string): Promise<FixtureAPI> {
  let currentScene = initialScene;
  let ready = false;
  let preparing = false;
  let session: FixtureSession = createSession();
  let serial: Promise<unknown> = Promise.resolve();
  const stops: Array<() => void> = [];

  setLang(language);
  applyDocumentLang();
  setTelemetrySender((body) => record("lifecycle", "telemetry", [JSON.parse(body)]));

  // Explicit browser adapters, released on teardown.
  const onVisibility = () => handleFullTerminalVisibility(document.visibilityState === "hidden");
  document.addEventListener("visibilitychange", onVisibility);
  stops.push(() => document.removeEventListener("visibilitychange", onVisibility));
  const onKey = (event: KeyboardEvent) => {
    if (phase() !== "live" || currentScreen() !== "pane" || termSelect() || isFullTerminal() || isAgentChat() || event.defaultPrevented) return;
    if (event.target instanceof HTMLElement && event.target.closest("button, a, input, textarea, select, summary, dialog, [role='button'], [contenteditable='true']")) return;
    handlePaneKey(event, false);
  };
  document.addEventListener("keydown", onKey);
  stops.push(() => document.removeEventListener("keydown", onKey));
  const media = window.matchMedia("(min-width: 900px)");
  const onDeskChange = () => { if (phase() === "live") commitView(); };
  media.addEventListener("change", onDeskChange);
  stops.push(() => media.removeEventListener("change", onDeskChange));
  stops.push(bindVisualViewport(() => {
    if (phase() !== "live" || currentScreen() !== "pane" || isFullTerminal()) return;
    requestAnimationFrame(() => {
      if (isAgentChat()) stickAgentStream();
      else if (paneFollow()) stickBottom();
    });
  }, (open) => {
    if (!open || phase() !== "live" || currentScreen() !== "pane" || isFullTerminal() || isAgentChat()) return;
    requestAnimationFrame(revealCaretRow);
  }));
  stops.push(bindLegacyGestureBoundary(document));
  stops.push(bindRippleSurface(document));
  stops.push(initSwipeBack());
  window.addEventListener("beforeunload", dispose, { once: true });

  function ensureAppMounted(): void {
    if (isAppMounted()) return;
    // Production seam: adopt the prepared session description before React renders.
    if (!sessionOwnerPreparer()) registerSessionOwnerPreparer(registerSessionView);
    mountApp();
  }

  function dispose(): void {
    for (const stop of stops.splice(0)) stop();
    registerSessionOwnerPreparer(null);
    resetTelemetry();
    disposeTerminalShell();
    if (isAppMounted()) unmountApp();
    session.dispose();
  }

  const snapshot = (): FixtureSnapshot => {
    const root = document.getElementById("app");
    const elements = root ? [...root.querySelectorAll("*")] : [];
    const reactElements = elements.filter(isReactElement).length;
    const rects = Object.fromEntries(RECT_SELECTORS.map((selector) => [selector, [...document.querySelectorAll(selector)].map(rect)]));
    const inputs = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("#app input, #app textarea")].map((input) => ({
      nodeId: nodeId(input), selector: input.id ? `#${input.id}` : `${input.tagName.toLowerCase()}.${input.className}`,
      value: input.value, focused: document.activeElement === input,
      selection: [input.selectionStart, input.selectionEnd] as [number | null, number | null],
    }));
    return {
      scene: currentScene, mode: "react" as FixtureMode, ready, shellOnly: !!scenes.find((scene) => scene.name === currentScene)?.shellOnly,
      reactOwned: root ? [...root.children].some(isReactElement) : false, reactElements,
      viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale ?? 1 },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: lang(),
      appClass: root?.className ?? "", bodyClass: document.body.className, rootClass: document.documentElement.className,
      phase: phase(), screen: currentScreen(),
      overflow: { documentX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        appX: root ? Math.max(0, root.scrollWidth - root.clientWidth) : 0 },
      rects, inputs, calls: structuredClone(calls), errors: [...errors] };
  };

  const waitForTerminalScene = async (name: string, expected: "live" | "error"): Promise<void> => {
    // Bounded observable readiness: the real controller's live/error stage plus
    // its TerminalOpen RPC call — never just paint drains. Throws (so the scene
    // is NOT marked ready) rather than swallowing the timeout.
    for (let attempt = 0; attempt < 400; attempt++) {
      const view = getFullTerminalView();
      if (view.stage === expected && calls.some((call) => call.method === "terminalOpen")) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`QA terminal scene "${name}" did not reach stage "${expected}" with a TerminalOpen call within the bounded wait (stage=${getFullTerminalView().stage})`);
  };

  const select = async (name: string): Promise<FixtureSnapshot> => {
    if (!scenes.some((scene) => scene.name === name)) throw new Error(`Unknown QA scene: ${name}`);
    preparing = true;
    ready = false;
    document.documentElement.dataset.qaReady = "false";
    const shellOnly = scenes.find((scene) => scene.name === name)?.shellOnly === true;
    dropQueuedKeys();
    guidedScrollController.dispose();
    releaseBoardScroll();
    disposeFullTerminal();
    resetTelemetry();
    for (const dialog of document.querySelectorAll("dialog")) { if (dialog.open) dialog.close(); dialog.remove(); }
    // A deliberate complete-fixture remount boundary: retire whichever fixture
    // owned the PREVIOUS scene before installing this one. The standalone shell
    // fixture owns its own root and must release #app before the stable App
    // mounts; the App never unmounts for ordinary scene-to-scene changes.
    disposeTerminalShell();
    if (shellOnly) {
      if (isAppMounted()) unmountApp();
    }
    session.dispose();
    session = createSession();
    session.live.onEvent(handleFullTerminalEvent);
    currentScene = name;
    calls.length = 0;
    errors.length = 0;
    resetFixtureBaseline(session);
    try {
      await applyScene(name, session);
    } finally {
      preparing = false;
    }
    if (shellOnly) {      renderTerminalShell(name === "terminal-error");
    } else {
      ensureAppMounted();
      commitView();
    }
    window.scrollTo(0, 0);
    applyVisualViewport();
    await settlePaint();
    afterScenePaint(name);
    await settlePaint();
    // QA readiness for the two real-engine terminal scenes must mean the actual
    // live/error stage and its TerminalOpen RPC have landed, never a paused
    // loader frame. The deliberate shellOnly scenes already render their final
    // state through their own fixture and are not gated here.
    if (name === "terminal-live" || name === "terminal-open-error") {
      await waitForTerminalScene(name, name === "terminal-live" ? "live" : "error");
    }
    ready = true;
    document.documentElement.dataset.qaReady = "true";
    document.documentElement.dataset.qaScene = name;
    return snapshot();
  };

  const api: FixtureAPI = {
    mode: "react", scenes, ready: Promise.resolve(), calls,
    setScene(name) {
      const next = serial.then(() => select(name));
      serial = next.catch(() => undefined);
      return next;
    },
    async setLanguage(value) { setLang(value); applyDocumentLang(); return api.setScene(currentScene); },
    async render() {
      if (scenes.find((scene) => scene.name === currentScene)?.shellOnly) await settlePaint();
      else if (!isAppMounted()) { ensureAppMounted(); commitView(); }
      else commitView();
      applyVisualViewport();
      await settlePaint();
      return snapshot();
    },
    snapshot,
    clearCalls() { calls.length = 0; },
    setConnected(value) { session.setConnected(value); setNetworkOnline(value); },
    emit(event) { session.emit(event); },
    terminalFrame(text, options) { return session.terminalFrame(text, options); },
    hold(method) { session.hold(method); },
    release(method) { session.release(method); },
    failNext(method, code) { session.failNext(method, code); },
  };
  api.ready = api.setScene(initialScene).then(() => undefined);
  return api;
}