import { pickResumeCredential } from "../lib/computer-catalog";
import { bindRippleSurface } from "../lib/dom";
import { bindLegacyGestureBoundary } from "../lib/gesture-boundary";
import { detectLang, initI18n, langPref, setLang, t } from "../lib/i18n";
import { messageOf } from "../lib/notices";
import { loadOriginConfig, originConfigErrorIsRecoverable } from "../lib/origin-config";
import { track } from "../lib/telemetry";
import { registerSessionView } from "../features/session/register";
import { preloadFullTerminalXterm } from "../features/session/full-terminal/full-terminal-loader";
import { handleFullTerminalVisibility } from "../features/session/full-terminal/full-terminal";
import { initSwipeBack } from "../features/session/pane-actions";
import { stickAgentStream } from "../features/session/chat/agent-chat-controller";
import { handlePaneKey } from "../features/session/guided/compose";
import { revealCaretRow, stickBottom } from "../features/session/guided/term";
import { resumeComputer } from "../features/computers/actions";
import {
  reconnectLiveSessions,
  refreshRuntimeState,
  reloadComputers,
  setLiveNetworkAvailable,
  startPolling,
  stopPolling,
} from "../features/connection/controller";
import { applyOriginPairingPolicy, beginPairing } from "../features/pairing/actions";
import { commitApp } from "./commit";
import { registerSessionOwnerPreparer, sessionOwnerPreparer } from "./frame";
import { hydrateApplicationState } from "./hydrate";
import { mountApp, unmountApp } from "./mount";
import { computers, lastUsedDaemon, liveSession, setAddingComputer } from "../features/computers/catalog-store";
import {
  applyOriginConfig,
  capturePairingFragment,
  clearNotificationTarget,
  connectionStore,
  networkOnline,
  phase as currentPhase,
  sessionTransport as currentSessionTransport,
  setNetworkOnline,
  setPhase,
} from "../features/connection/connection-store";
import { currentScreen } from "./navigation-store";
import { clearNotice, showError, showStatus } from "./notices-store";
import { isAgentChat, isFullTerminal, paneFollow, termSelect } from "../features/session/session-store";
import { resetTransitionState, takeTransition, withTransition } from "./transition";
import { bindVisualViewport, releaseVisualViewport } from "./viewport";

/**
 * Browser boot and lifecycle.
 *
 * This is the only module that wires the page to the application: it hydrates the
 * domains from the browser, mounts `<App/>` once, binds the platform listeners
 * that belong to the page lifetime, and runs the boot decision. Start and stop
 * are idempotent: a second start is a no-op, and stop releases exactly what
 * start acquired so a later start can run cleanly.
 *
 * Boot reads the typed canonical readers and scoped notice actions directly —
 * the compatibility `state` facade and the paint bridge are not part of this
 * module's surface. It binds the session feature's owner adoption on the frame
 * seam before the first commit, clearing the seam when the page lifecycle stops.
 */

let bootBlockedByNetwork = false;
let running: (() => void) | null = null;
let bootGeneration = 0;

/**
 * Direct boot commit.
 *
 * Boot's only entry into the commit pipeline. A declared transition commits
 * synchronously so the native view-transition callback captures the arriving
 * DOM; with nothing declared the option stays unset, so a composition change is
 * still synchronous but an ordinary same-page update is left to React.
 *
 * This is the boot/native async adapter, distinct from the synchronous
 * controller `commitView`: boot lets `startViewTransition` capture the old DOM
 * and runs the real commit inside native's update callback with sync intent so
 * it captures the arriving DOM. Do not replace it with `commitView`, run the
 * update before the native callback, or add an async-return promise where the
 * caller was fire-and-forget.
 */
function commitBootView(): void {
  const kind = takeTransition();
  withTransition(kind, () => commitApp(kind === "none" ? {} : { sync: true }));
}

export function startApplication(): () => void {
  if (running) return running;
  const generation = ++bootGeneration;
  const page = new AbortController();
  const { signal } = page;
  const releases: Array<() => void> = [];

  const stop = (): void => {
    if (running !== stop) return;
    running = null;
    bootGeneration += 1;
    page.abort();
    for (const release of releases) release();
    // Retire this lifetime's session-owner registration before the teardown
    // publications: unmountApp publishes a fully retired frame, and a frame
    // subscriber may mount a replacement application off that notification.
    // The seam must already be vacant so the replacement's own install (the
    // same registerSessionView function) finds it empty and keeps it — a
    // stopped lifecycle never unregisters its replacement, so an old stop
    // cannot clear the seam its successor is using.
    registerSessionOwnerPreparer(null);
    unmountApp();
    resetTransitionState();
    releaseVisualViewport();
  };

  running = stop;
  try {
    hydrateApplicationState();
    initI18n();
    bindLanguageChange(signal);
    capturePairingFragment();
    // Bind the session feature's owner adoption on the frame seam before the
    // first commit: every prepared session composition (phone chat, desk chat,
    // guided, complete terminal) then adopts its owner before React renders.
    // A caller that already injected a preparer (fixture, controller) keeps it.
    if (!sessionOwnerPreparer()) registerSessionOwnerPreparer(registerSessionView);
    mountApp();
    if (running !== stop) return stop;
    bindNetworkLifecycle(signal);
    bindResponsiveLayout(signal);
    // Pending frames only: a delivered callback removes its id before the
    // ownership check, so completed frames never accumulate for the page
    // lifetime and stop cancels only work that can still run.
    const pageRafs = new Set<number>();
    const schedulePageRaf = (work: () => void): void => {
      if (running !== stop) return;
      const id = requestAnimationFrame(() => {
        pageRafs.delete(id);
        if (running !== stop) return;
        work();
      });
      pageRafs.add(id);
    };
    releases.push(() => {
      for (const id of pageRafs) cancelAnimationFrame(id);
      pageRafs.clear();
    });
    releases.push(bindVisualViewport(() => {
      if (currentPhase() === "live" && currentScreen() === "pane" && !isFullTerminal()) {
        schedulePageRaf(() => {
          if (isAgentChat()) {
            stickAgentStream();
            return;
          }
          if (paneFollow()) stickBottom();
        });
      }
    }, (open) => {
      if (!open || currentPhase() !== "live" || currentScreen() !== "pane" || isFullTerminal() || isAgentChat()) return;
      schedulePageRaf(revealCaretRow);
    }));
    releases.push(bindLegacyGestureBoundary(document));
    releases.push(bindRippleSurface(document));
    bindPaneKeys(signal);
    releases.push(initSwipeBack());
    registerServiceWorkerAfterLoad(signal);
    void boot(generation);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

export function stopApplication(): void {
  running?.();
}

export function applicationIsRunning(): boolean {
  return running !== null;
}

function bindLanguageChange(signal: AbortSignal): void {
  window.addEventListener("languagechange", () => {
    if (langPref() !== "auto") return;
    setLang(detectLang());
    clearNotice();
    commitBootView();
  }, { signal });
}

function applyNetworkAvailability(available: boolean): void {
  const changed = setNetworkOnline(available);
  setLiveNetworkAvailable(available);
  if (!available) {
    stopPolling();
    if (currentPhase() === "live") showStatus(t("net.offline"), true);
    commitBootView();
    return;
  }
  if (currentPhase() !== "live" || document.visibilityState !== "visible") {
    if (bootBlockedByNetwork && currentPhase() === "connect") void boot(bootGeneration);
    return;
  }
  if (currentSessionTransport() === "p2p") preloadFullTerminalXterm();
  if (changed || !liveSession()?.isConnected()) showStatus(t("net.restored"));
  if (!changed) reconnectLiveSessions("probe");
  startPolling();
  void refreshRuntimeState();
  commitBootView();
}

function bindNetworkLifecycle(signal: AbortSignal): void {
  document.addEventListener("visibilitychange", () => {
    handleFullTerminalVisibility(document.visibilityState === "hidden");
    if (document.visibilityState === "hidden") stopPolling();
    else applyNetworkAvailability(navigator.onLine !== false);
  }, { signal });

  window.addEventListener("online", () => applyNetworkAvailability(true), { signal });
  window.addEventListener("offline", () => applyNetworkAvailability(false), { signal });

  const connection = (navigator as Navigator & { connection?: EventTarget; mozConnection?: EventTarget; webkitConnection?: EventTarget }).connection
    ?? (navigator as Navigator & { mozConnection?: EventTarget }).mozConnection
    ?? (navigator as Navigator & { webkitConnection?: EventTarget }).webkitConnection;
  connection?.addEventListener("change", () => {
    if (currentPhase() === "live" && networkOnline()) reconnectLiveSessions("path");
  }, { signal } as AddEventListenerOptions);

  window.addEventListener("pageshow", () => {
    if (document.visibilityState === "visible") applyNetworkAvailability(navigator.onLine !== false);
  }, { signal });
}

function bindResponsiveLayout(signal: AbortSignal): void {
  const media = window.matchMedia("(min-width: 900px)");
  const onDeskChange = (): void => {
    if (currentPhase() === "live") commitBootView();
  };
  media.addEventListener("change", onDeskChange, { signal });
  // Some engines ignore the signal option on MediaQueryList; release the exact
  // listener so a stopped application can never commit from a resize.
  signal.addEventListener("abort", () => media.removeEventListener("change", onDeskChange), { once: true });
}

function bindPaneKeys(signal: AbortSignal): void {
  document.addEventListener("keydown", (event) => {
    if (currentPhase() !== "live" || currentScreen() !== "pane" || termSelect() || isFullTerminal() || isAgentChat()) return;
    if (event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button, a, input, textarea, select, summary, dialog, [role='button'], [contenteditable='true']")
    )
      return;
    handlePaneKey(event, false);
  }, { signal });
}

async function boot(generation: number): Promise<void> {
  if (generation !== bootGeneration) return;
  if (!networkOnline()) {
    bootBlockedByNetwork = true;
    setPhase("connect");
    showStatus(t("net.offlineContinue"), true);
    track("pwa_boot", { result: "offline", extra: "connect" });
    if (generation === bootGeneration) commitBootView();
    return;
  }
  bootBlockedByNetwork = false;
  clearNotice();
  setPhase("boot");
  commitBootView();
  try {
    const config = await loadOriginConfig();
    if (generation !== bootGeneration) return;
    applyOriginConfig(config);
  } catch (error) {
    if (generation !== bootGeneration) return;
    // Keep the existing network lifecycle eligible to resume a failed config read.
    bootBlockedByNetwork = originConfigErrorIsRecoverable(error);
    setPhase("connect");
    showError(messageOf(error), true);
    track("pwa_boot", { result: "bad_relay", extra: "connect" });
    commitBootView();
    return;
  }
  if (generation !== bootGeneration) return;
  try {
    await reloadComputers(() => generation === bootGeneration);
    if (generation !== bootGeneration) return;
  } catch (error) {
    if (generation !== bootGeneration) return;
    setPhase("connect");
    showError(messageOf(error), true);
    track("pwa_boot", { result: "connect", extra: "connect" });
    commitBootView();
    return;
  }
  if (generation !== bootGeneration) return;
  const catalog = computers();
  const notificationTarget = connectionStore.get().notificationTarget;
  const notificationPair = notificationTarget
    ? catalog.find((item) => item.daemonId === notificationTarget.daemonId)
    : undefined;
  if (notificationTarget && !notificationPair) {
    clearNotificationTarget();
    showError(t("err.notifyComputerGone"), true);
  }
  if (applyOriginPairingPolicy()) {
    setPhase(catalog.length ? "pick" : "connect");
    track("pwa_boot", { result: "ok", extra: currentPhase() });
    commitBootView();
    return;
  }
  const fragment = connectionStore.get().fragment;
  if (fragment) {
    setAddingComputer(catalog.length > 0);
    setPhase("connect");
    track("pwa_boot", { result: "ok", extra: "pairing" });
    commitBootView();
    await beginPairing(fragment.code);
    return;
  }
  if (!catalog.length) {
    setPhase("connect");
    track("pwa_boot", { result: "ok", extra: "connect" });
    commitBootView();
    return;
  }
  const pair = pickResumeCredential([...catalog], notificationPair?.daemonId || lastUsedDaemon());
  if (!pair) {
    setPhase("pick");
    track("pwa_boot", { result: "ok", extra: "pick" });
    commitBootView();
    return;
  }
  track("pwa_boot", { result: "ok", extra: "resume" });
  await resumeComputer(pair);
  if (generation !== bootGeneration) return;
}

function registerServiceWorkerAfterLoad(signal: AbortSignal): void {
  if (!("serviceWorker" in navigator)) return;
  const register = (): void => {
    const timer = window.setTimeout(() => {
      const onPair = location.pathname === "/pair" || location.pathname.startsWith("/pair/");
      void navigator.serviceWorker.register("/sw.js", { scope: onPair ? "/pair" : "/" }).catch(() => undefined);
    }, 1_000);
    signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true, signal });
}
