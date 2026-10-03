import { pickResumeCredential } from "../lib/computer-catalog";
import { bindRippleSurface, hasOpenDialog } from "../lib/dom";
import { bindLegacyGestureBoundary } from "../lib/gesture-boundary";
import { detectLang, initI18n, langPref, setLang, t } from "../lib/i18n";
import { messageOf } from "../lib/notices";
import { loadOriginConfig, originConfigErrorIsRecoverable } from "../lib/origin-config";
import { track } from "../lib/telemetry";
import { registerSessionView } from "../features/session/register";
import { preloadFullTerminalXterm } from "../features/session/full-terminal/full-terminal-loader";
import { handleFullTerminalVisibility } from "../features/session/full-terminal/full-terminal";
import { initSwipeBack } from "../features/session/pane-actions";
import { restoreAgentReadingPosition } from "../features/session/chat/agent-chat-controller";
import { handlePaneKey } from "../features/session/guided/compose";
import { revealCaretRow, stickBottom } from "../features/session/guided/term";
import { resumeComputer } from "../features/computers/actions";
import {
  reconnectLiveSessions,
  recoverVisibleSession,
  reloadComputers,
  retireAgentTraceRefreshes,
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
  setBootBlocked,
  type BootBlock,
} from "../features/connection/connection-store";
import { currentScreen } from "./navigation-store";
import { clearNotice, showError, showStatus } from "./notices-store";
import { isAgentChat, isFullTerminal, paneFollow, termSelect } from "../features/session/session-store";
import { resetTransitionState, takeTransition, withTransition } from "./transition";
import { bindVisualViewport, releaseVisualViewport } from "./viewport";
import { bindBootRecovery } from "./boot-actions";
import { forgetSavedComputerCount } from "../lib/credentials";
import type { OriginConfig } from "../lib/origin-config";
import { recordConnectionDiagnostic } from "../lib/protocol/connection-diagnostics";

/**
 * Browser boot and lifecycle.
 *
 * This is the only module that wires the page to the application: it hydrates the
 * domains from the browser, mounts `<App/>` once, binds the platform listeners
 * that belong to the page lifetime, and runs the boot decision. Start and stop
 * are idempotent: a second start is a no-op, and stop releases exactly what
 * start acquired so a later start can run cleanly.
 *
 * Boot uses typed canonical readers and scoped notice actions. It binds the
 * session feature's owner adoption on the frame
 * seam before the first commit, clearing the seam when the page lifecycle stops.
 */

let bootBlockedByNetwork = false;
let running: (() => void) | null = null;
let bootGeneration = 0;
let bootRetryTimer: number | null = null;
let bootRetryDelay = 1500;

/** Preserve the boot decision across refresh without storing identity or keys. */
function trackBoot(fields: { result: string; extra: string }): void {
  track("pwa_boot", fields);
  recordConnectionDiagnostic({ event: "boot_decision", code: fields.result, reason: fields.extra,
    phase: currentPhase(), usable_count: computers().length });
}

function clearBootRetry(): void {
  if (bootRetryTimer !== null) window.clearTimeout(bootRetryTimer);
  bootRetryTimer = null;
}

/**
 * Retry only a held boot (catalog or origin config read), never a pairing or a
 * live-session mutation. A tap re-reads the browser's reachability first: the
 * offline hold otherwise waits for an `online` event that may never come.
 */
function retryBlockedBoot(manual = false): void {
  if (!running || currentPhase() !== "boot" || !connectionStore.get().bootBlocked
    || document.visibilityState === "hidden") return;
  if (manual && navigator.onLine !== false && !networkOnline()) setNetworkOnline(true);
  void boot(bootGeneration);
}

/** Pairing again is the reader's explicit choice, never a storage fallback. */
function pairDespiteSavedComputers(): void {
  if (!running || currentPhase() !== "boot" || connectionStore.get().bootBlocked !== "storage") return;
  forgetSavedComputerCount();
  void boot(bootGeneration);
}

/**
 * Hold boot on a recoverable failure while saved computers exist. Storage and
 * origin holds retry with backoff while visible; the offline hold resumes on
 * the network lifecycle, since nothing can succeed before it is back.
 */
function holdBoot(block: BootBlock, generation: number): void {
  setBootBlocked(block);
  if (block !== "offline" && document.visibilityState !== "hidden") {
    bootRetryTimer = window.setTimeout(() => {
      bootRetryTimer = null;
      if (generation === bootGeneration) retryBlockedBoot();
    }, bootRetryDelay);
    bootRetryDelay = Math.min(bootRetryDelay * 2, 15000);
  }
  commitBootView();
}

type ConfigRead = { ok: true; config: OriginConfig } | { ok: false; error: unknown };

function readOriginConfig(): Promise<ConfigRead> {
  return loadOriginConfig().then((config) => ({ ok: true as const, config }), (error: unknown) => ({ ok: false as const, error }));
}

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
    clearBootRetry();
    setBootBlocked(null);
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
  bootRetryDelay = 1500;
  releases.push(bindBootRecovery({ retry: () => retryBlockedBoot(true), pairAnyway: pairDespiteSavedComputers }));
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
            restoreAgentReadingPosition();
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
  recordConnectionDiagnostic({ event: "network_lifecycle", phase: currentPhase(),
    hidden: document.visibilityState === "hidden", reason: available ? "online" : "offline" });
  const changed = setNetworkOnline(available);
  setLiveNetworkAvailable(available);
  if (!available) {
    stopPolling();
    if (currentPhase() === "live") showStatus(t("net.offline"), true);
    commitBootView();
    return;
  }
  if (currentPhase() !== "live" || document.visibilityState !== "visible") {
    retryBlockedBoot();
    if (bootBlockedByNetwork && currentPhase() === "connect") void boot(bootGeneration);
    return;
  }
  if (currentSessionTransport() === "p2p") preloadFullTerminalXterm();
  if (changed) showStatus(t("net.restored"));
  if (!changed) reconnectLiveSessions("probe");
  if (liveSession()?.isConnected()) {
    startPolling();
    void recoverVisibleSession();
  }
  commitBootView();
}

function bindNetworkLifecycle(signal: AbortSignal): void {
  document.addEventListener("visibilitychange", () => {
    handleFullTerminalVisibility(document.visibilityState === "hidden");
    if (document.visibilityState === "hidden") {
      clearBootRetry();
      retireAgentTraceRefreshes();
      stopPolling();
    } else applyNetworkAvailability(navigator.onLine !== false);
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

export function bindPaneKeys(signal: AbortSignal): void {
  document.addEventListener("keydown", (event) => {
    if (currentPhase() !== "live" || currentScreen() !== "pane" || termSelect() || isFullTerminal() || isAgentChat()) return;
    if (event.defaultPrevented) return;
    // A native modal dialog is open: never forward typing keys to the pane. This
    // is checked before the target guard because focus can drop to <body> (the
    // Insert All/focused button being disabled), so an ESC or printable key must
    // not leak into the PTY — native Escape keeps closing the top modal.
    if (hasOpenDialog()) return;
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
  clearBootRetry();
  setBootBlocked(null);
  bootBlockedByNetwork = false;
  clearNotice();
  setPhase("boot");
  commitBootView();
  // The catalog is local: read it beside the origin config, so a network
  // failure can never hide saved computers behind the pairing page.
  const configRead = networkOnline() ? readOriginConfig() : null;
  try {
    await reloadComputers(() => generation === bootGeneration);
    if (generation !== bootGeneration) return;
  } catch {
    if (generation !== bootGeneration) return;
    // A suspended browser's storage service can fail independently of the
    // network. Never interpret that as an empty catalog or ask to pair again.
    trackBoot({ result: "storage_unavailable", extra: "boot" });
    holdBoot("storage", generation);
    return;
  }
  const saved = computers().length > 0;
  if (!configRead) {
    trackBoot({ result: "offline", extra: saved ? "boot" : "connect" });
    if (saved) {
      holdBoot("offline", generation);
      return;
    }
    bootBlockedByNetwork = true;
    setPhase("connect");
    showStatus(t("net.offlineContinue"), true);
    commitBootView();
    return;
  }
  const read = await configRead;
  if (generation !== bootGeneration) return;
  if (!read.ok) {
    // Keep the existing network lifecycle eligible to resume a failed config read.
    const recoverable = originConfigErrorIsRecoverable(read.error);
    trackBoot({ result: "bad_relay", extra: saved && recoverable ? "boot" : "connect" });
    if (saved && recoverable) {
      holdBoot("origin", generation);
      return;
    }
    bootBlockedByNetwork = recoverable;
    setPhase("connect");
    showError(messageOf(read.error), true);
    commitBootView();
    return;
  }
  applyOriginConfig(read.config);
  bootRetryDelay = 1500;
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
    trackBoot({ result: "ok", extra: currentPhase() });
    commitBootView();
    return;
  }
  const fragment = connectionStore.get().fragment;
  if (fragment) {
    setAddingComputer(catalog.length > 0);
    setPhase("connect");
    trackBoot({ result: "ok", extra: "pairing" });
    commitBootView();
    await beginPairing(fragment.code);
    return;
  }
  if (!catalog.length) {
    setPhase("connect");
    trackBoot({ result: "ok", extra: "connect" });
    commitBootView();
    return;
  }
  const pair = pickResumeCredential([...catalog], notificationPair?.daemonId || lastUsedDaemon());
  if (!pair) {
    setPhase("pick");
    trackBoot({ result: "ok", extra: "pick" });
    commitBootView();
    return;
  }
  trackBoot({ result: "ok", extra: "resume" });
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
