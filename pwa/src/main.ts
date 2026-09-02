import "./style.css";
import { detectLang, initI18n, langPref, setLang, t } from "./lib/i18n";
import { computerTitle, pickResumeCredential } from "./lib/computer-catalog";
import { loadOriginConfig } from "./lib/origin-config";
import { resumeComputer } from "./computers";
import {
  reconnectLiveSessions,
  reloadComputers,
  refreshRuntimeState,
  setLiveNetworkAvailable,
  startPolling,
  stopPolling,
} from "./live";
import { applyOriginPairingPolicy, beginPairing } from "./pairing";
import { render as paint, setRenderer } from "./paint";
import { app, capturePairingFragment, clearNotice, messageOf, showError, showStatus, state, termLineHeightPx } from "./state";
import { bindVisualViewport, isDesk } from "./viewport";
import { brandNode, spinnerNode } from "./ui/chrome";
import { renderComputers } from "./ui/computers";
import { renderConnect } from "./ui/connect";
import { renderDesk } from "./ui/desk";
import { renderHome } from "./ui/home";
import { initSwipeBack, renderPane } from "./ui/pane";
import { renderSettings } from "./ui/settings";
import { renderWorkspace } from "./ui/workspace";
import { stickAgentStream } from "./ui/agent-chat";
import { handlePaneKey, stickBottom } from "./ui/session-view";
import { node } from "./lib/dom";
import { handleFullTerminalVisibility } from "./ui/full-terminal";
import { preloadFullTerminalXterm } from "./ui/full-terminal-loader";
import { track } from "./lib/telemetry";

initI18n();
window.addEventListener("languagechange", () => {
  if (langPref() !== "auto") return;
  setLang(detectLang());
  clearNotice();
  paint();
});
capturePairingFragment();
let bootBlockedByNetwork = false;

function renderLive(): void {
  if (state.screen === "workspace") {
    renderWorkspace();
    return;
  }
  if (state.fullTerminal) {
    renderPane();
    return;
  }
  if (isDesk()) {
    renderDesk();
    return;
  }
  if (state.screen === "settings") renderSettings();
  else if (state.screen === "computers") renderComputers();
  else if (state.screen === "pane") renderPane();
  else renderHome();
}

function render(): void {
  const workspace = state.phase === "live" && state.screen === "workspace";
  const desk = state.phase === "live" && isDesk() && !state.fullTerminal && !workspace;
  const session = state.phase === "live" && state.screen === "pane" && (!desk || state.fullTerminal);
  const booting = state.phase === "boot" || state.phase === "resuming";
  app.classList.toggle("session", session);
  app.classList.toggle("desk", desk);
  app.classList.toggle("workspace", workspace);
  app.classList.toggle("boot-screen", booting);
  document.documentElement.classList.toggle("lock", session || desk || workspace || booting);
  document.body.classList.toggle("lock", session || desk || workspace || booting);
  app.style.setProperty("--term-fs", `${state.termFontPx}px`);
  app.style.setProperty("--term-lh", `${termLineHeightPx(state.termFontPx)}px`);
  app.setAttribute("aria-busy", state.operationBusy ? "true" : "false");
  if (state.phase === "boot" || state.phase === "resuming") {
    const wrap = node("div", "boot");
    wrap.append(
      brandNode(),
      spinnerNode(),
      node(
        "p",
        "boot-text",
        state.phase === "boot"
          ? t("boot.reading")
          : t("boot.connecting", { name: state.credential ? computerTitle(state.credential) : t("boot.computer") }),
      ),
    );
    app.replaceChildren(wrap);
  } else if (state.phase === "connect" || state.phase === "pairing") renderConnect();
  else if (state.phase === "pick") renderComputers();
  else renderLive();
}

setRenderer(render);

function applyNetworkAvailability(available: boolean): void {
  const changed = state.networkOnline !== available;
  state.networkOnline = available;
  setLiveNetworkAvailable(available);
  if (!available) {
    stopPolling();
    if (state.phase === "live") showStatus(t("net.offline"), true);
    paint();
    return;
  }
  if (state.phase !== "live" || document.visibilityState !== "visible") {
    if (bootBlockedByNetwork && state.phase === "connect") void boot();
    return;
  }
  if (state.sessionTransport === "p2p") preloadFullTerminalXterm();
  if (changed || !state.live?.isConnected()) showStatus(t("net.restored"));
  if (!changed) reconnectLiveSessions("probe");
  startPolling();
  void refreshRuntimeState();
  paint();
}

document.addEventListener("visibilitychange", () => {
  handleFullTerminalVisibility(document.visibilityState === "hidden");
  if (document.visibilityState === "hidden") stopPolling();
  else applyNetworkAvailability(navigator.onLine !== false);
});

window.addEventListener("online", () => applyNetworkAvailability(true));
window.addEventListener("offline", () => applyNetworkAvailability(false));
const networkConnection = (navigator as Navigator & { connection?: EventTarget; mozConnection?: EventTarget; webkitConnection?: EventTarget }).connection
  ?? (navigator as Navigator & { mozConnection?: EventTarget }).mozConnection
  ?? (navigator as Navigator & { webkitConnection?: EventTarget }).webkitConnection;
networkConnection?.addEventListener("change", () => {
  if (state.phase === "live" && state.networkOnline) reconnectLiveSessions("path");
});
window.addEventListener("pageshow", () => {
  if (document.visibilityState === "visible") applyNetworkAvailability(navigator.onLine !== false);
});

window.matchMedia("(min-width: 900px)").addEventListener("change", () => {
  if (state.phase === "live") paint();
});

bindVisualViewport(() => {
  // Keyboard open/close changes the scrollport height. Do not run this on
  // visualViewport "scroll": iOS fires that during a finger pan and it would
  // pin the buffer to the bottom so a swipe looks like it did nothing.
  if (state.phase === "live" && state.screen === "pane" && !state.fullTerminal) {
    requestAnimationFrame(() => {
      if (state.agentChat) {
        stickAgentStream();
        return;
      }
      if (state.paneFollow) stickBottom();
    });
  }
});

// Older iOS standalone WebKit can ignore viewport scale limits for its legacy
// gesture events. Keep the application shell fixed while preserving ordinary
// one-finger scrolling inside pages and the terminal.
for (const type of ["gesturestart", "gesturechange"] as const) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

document.addEventListener("keydown", (event) => {
  if (state.phase !== "live" || state.screen !== "pane" || state.termSelect || state.fullTerminal || state.agentChat) return;
  if (event.defaultPrevented) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest("button, a, input, textarea, select, summary, dialog, [role='button'], [contenteditable='true']")
  )
    return;
  handlePaneKey(event, false);
});

initSwipeBack();

async function boot(): Promise<void> {
  if (!state.networkOnline) {
    bootBlockedByNetwork = true;
    state.phase = "connect";
    showStatus(t("net.offlineContinue"), true);
    track("pwa_boot", { result: "offline", extra: "connect" });
    paint();
    return;
  }
  bootBlockedByNetwork = false;
  clearNotice();
  state.phase = "boot";
  paint();
  try {
    const config = await loadOriginConfig();
    state.originProtocol = config.protocol;
    state.p2pEnabled = config.p2p;
  } catch (error) {
    state.phase = "connect";
    showError(messageOf(error), true);
    track("pwa_boot", { result: "bad_relay", extra: "connect" });
    paint();
    return;
  }
  try {
    await reloadComputers();
  } catch (error) {
    state.phase = "connect";
    showError(messageOf(error), true);
    track("pwa_boot", { result: "connect", extra: "connect" });
    paint();
    return;
  }
  const notificationPair = state.notificationTarget
    ? state.computers.find((item) => item.daemonId === state.notificationTarget?.daemonId)
    : undefined;
  if (state.notificationTarget && !notificationPair) {
    state.notificationTarget = null;
    showError(t("err.notifyComputerGone"), true);
  }
  if (applyOriginPairingPolicy()) {
    state.phase = state.computers.length ? "pick" : "connect";
    track("pwa_boot", { result: "ok", extra: state.phase });
    paint();
    return;
  }
  if (state.fragment) {
    state.addingComputer = state.computers.length > 0;
    state.phase = "connect";
    track("pwa_boot", { result: "ok", extra: "pairing" });
    paint();
    await beginPairing(state.fragment.code);
    return;
  }
  if (!state.computers.length) {
    state.phase = "connect";
    track("pwa_boot", { result: "ok", extra: "connect" });
    paint();
    return;
  }
  const pair = pickResumeCredential(state.computers, notificationPair?.daemonId || state.lastUsedDaemonId);
  if (!pair) {
    state.phase = "pick";
    track("pwa_boot", { result: "ok", extra: "pick" });
    paint();
    return;
  }
  track("pwa_boot", { result: "ok", extra: "resume" });
  await resumeComputer(pair);
}

function registerServiceWorkerAfterLoad(): void {
  if (!("serviceWorker" in navigator)) return;
  const register = () => window.setTimeout(() => {
    const onPair = location.pathname === "/pair" || location.pathname.startsWith("/pair/");
    void navigator.serviceWorker.register("/sw.js", { scope: onPair ? "/pair" : "/" }).catch(() => undefined);
  }, 1_000);
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

registerServiceWorkerAfterLoad();
void boot();
