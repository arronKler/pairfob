import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { PairResult } from "../../lib/protocol/client";
import { ProtocolError } from "../../lib/protocol/errors";
import type { DesktopEvent, DesktopObservation, DesktopRPC } from "../../lib/protocol/remote-desktop";
import type { LiveSession } from "../../lib/protocol/session-types";
import { forgetConsole, saveConsole } from "../../lib/recovery-console";
import { attachLiveSession, setComputers, setCredential } from "../computers/catalog-store";
import { setNetworkMode, setPhase, setSessionTransport } from "../connection/connection-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { DESKTOP_PREFS_KEY, setDefaultAudio, setDefaultMode, setDefaultQuality, setTouchMode } from "./desktop-prefs";
import { getDesktopLive, setDesktopLive } from "./desktop-status";
import { DesktopScreen } from "./desktop-surface";

type OpenCall = { control: boolean; audio: boolean; quality: string };
type MockSessionCtrl = {
  openCalls: OpenCall[];
  inputEvents: DesktopEvent[];
  closeCalls: number;
  failNextOpen: Error | null;
  observation: DesktopObservation;
  pingFailures?: Array<Error | null>;
};

let savedRTC: unknown;
let savedMS: unknown;
let savedPlay: unknown;
let savedRVC: unknown;
let savedCancelRVC: unknown;
let savedMatchMedia: typeof window.matchMedia;
let savedWakeLockDesc: PropertyDescriptor | undefined;
let savedScreenDesc: PropertyDescriptor | undefined;
let pointerState = { fine: true, coarse: false };
let fineListeners: Array<() => void> = [];
let coarseListeners: Array<() => void> = [];

function installFakeWebRTC(frameCallbackRef: { cb?: VideoFrameRequestCallback }): void {
  class FakePeerConnection extends EventTarget {
    iceGatheringState = "complete";
    connectionState = "connected";
    localDescription = {
      type: "offer",
      sdp: "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ srflx\r\n",
    };
    addTransceiver() { return {}; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async getStats() { return new Map(); }
    close() { this.connectionState = "closed"; }
  }
  savedRTC = (globalThis as Record<string, unknown>).RTCPeerConnection;
  savedMS = (globalThis as Record<string, unknown>).MediaStream;
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
  (globalThis as Record<string, unknown>).MediaStream = happy.MediaStream;

  const proto = happy.HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  savedPlay = proto.play;
  savedRVC = proto.requestVideoFrameCallback;
  savedCancelRVC = proto.cancelVideoFrameCallback;
  proto.play = async function play(this: HTMLVideoElement) {
    Object.defineProperty(this, "videoWidth", { configurable: true, value: 1920 });
    Object.defineProperty(this, "videoHeight", { configurable: true, value: 1080 });
    Object.defineProperty(this, "readyState", { configurable: true, value: 4 });
    frameCallbackRef.cb?.(performance.now(), {
      presentationTime: performance.now(),
      expectedDisplayTime: performance.now(),
      width: 1920,
      height: 1080,
      mediaTime: 0,
      presentedFrames: 1,
      processingDuration: 1,
      rtpTimestamp: 101,
    });
    this.dispatchEvent(new happy.Event("playing"));
  };
  proto.requestVideoFrameCallback = function requestVideoFrameCallback(cb: VideoFrameRequestCallback) {
    frameCallbackRef.cb = cb;
    return 1;
  };
  proto.cancelVideoFrameCallback = () => {};
}

function uninstallFakeWebRTC(): void {
  const g = globalThis as Record<string, unknown>;
  if (savedRTC === undefined) delete g.RTCPeerConnection;
  else g.RTCPeerConnection = savedRTC;
  if (savedMS === undefined) delete g.MediaStream;
  else g.MediaStream = savedMS;
  const proto = happy.HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  proto.play = savedPlay;
  proto.requestVideoFrameCallback = savedRVC;
  proto.cancelVideoFrameCallback = savedCancelRVC;
}

function installPointerMatchMedia(): void {
  const baseMatch = savedMatchMedia;
  const makeList = (query: string, kind: "fine" | "coarse"): MediaQueryList => {
    const list = new EventTarget() as MediaQueryList;
    const pool = kind === "fine" ? fineListeners : coarseListeners;
    return Object.assign(list, {
      get matches() { return kind === "fine" ? pointerState.fine : pointerState.coarse; },
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
        if (type === "change" && typeof fn === "function") pool.push(fn as () => void);
      },
      removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
        if (type === "change" && typeof fn === "function") {
          const idx = pool.indexOf(fn as () => void);
          if (idx >= 0) pool.splice(idx, 1);
        }
      },
    });
  };
  const overridden = (query: string): MediaQueryList => {
    if (query.includes("pointer: fine")) return makeList(query, "fine");
    if (query.includes("any-pointer: coarse")) return makeList(query, "coarse");
    return baseMatch(query);
  };
  window.matchMedia = overridden;
  globalThis.matchMedia = overridden;
}

function createFakeSession(ctrl: MockSessionCtrl): LiveSession {
  const desktop = (): DesktopRPC => ({
    async open(_sdp, control, audio, quality) {
      ctrl.openCalls.push({ control, audio, quality });
      if (ctrl.failNextOpen) {
        const err = ctrl.failNextOpen;
        ctrl.failNextOpen = null;
        throw err;
      }
      return { sdp: "v=0\r\n", display: "Built-in Retina 16\"" };
    },
    async ping() {
      const nextErr = ctrl.pingFailures?.shift();
      if (nextErr) throw nextErr;
      return ctrl.observation;
    },
    async input(event) { ctrl.inputEvents.push(event); },
    async close() { ctrl.closeCalls += 1; },
  });
  return {
    desktop,
    isConnected: () => true,
    isChecking: () => false,
    connectionPhase: () => "connected",
    onEvent: () => () => {},
  } as unknown as LiveSession;
}

function sampleHost(): PairResult {
  return {
    deviceId: "dev_res1234",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: "d_res1234567890123",
    fp: "1".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "Browser",
    createdAt: 1_700_000_000_000,
    hostname: "Mac Studio",
    lastSeen: 1_700_000_000_000,
  };
}

function seedConnectedP2P(ctrl: MockSessionCtrl): PairResult {
  const host = sampleHost();
  setComputers([host]);
  setCredential(host);
  setPhase("live");
  setNetworkMode("auto");
  setSessionTransport("p2p");
  applyCapabilities({
    ...NO_OPERATION_CAPABILITIES,
    view_desktop: true,
    control_desktop: true,
    listen_desktop_audio: true,
  }, []);
  attachLiveSession(createFakeSession(ctrl));
  return host;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  savedMatchMedia = window.matchMedia.bind(window);
  savedWakeLockDesc = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  savedScreenDesc = Object.getOwnPropertyDescriptor(globalThis, "screen");
  fineListeners = [];
  coarseListeners = [];
  pointerState = { fine: true, coarse: false };
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  installPointerMatchMedia();
  setLang("zh");
  localStorage.removeItem(DESKTOP_PREFS_KEY);
  forgetConsole(sampleHost().daemonId);
  setDefaultMode("control");
  setDefaultQuality("balanced");
  setDefaultAudio(false);
  setTouchMode("trackpad");
  setDesktopLive(false);
});

afterEach(() => {
  act(() => unmountReact());
  uninstallFakeWebRTC();
  window.matchMedia = savedMatchMedia;
  globalThis.matchMedia = savedMatchMedia;
  if (savedWakeLockDesc) Object.defineProperty(navigator, "wakeLock", savedWakeLockDesc);
  else delete (navigator as unknown as Record<string, unknown>).wakeLock;
  if (savedScreenDesc) Object.defineProperty(globalThis, "screen", savedScreenDesc);
  else delete (globalThis as unknown as Record<string, unknown>).screen;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  setDesktopLive(false);
  attachLiveSession(null);
  setComputers([]);
  setCredential(null);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  forgetConsole(sampleHost().daemonId);
  localStorage.removeItem(DESKTOP_PREFS_KEY);
});

test("kicked error stops cleanly in disconnected with takeover copy and does NOT auto-reconnect", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
    pingFailures: [new ProtocolError("kicked", "desktop session taken over by another window")],
  };
  seedConnectedP2P(ctrl);

  await act(async () => {
    renderReact(<DesktopScreen onBack={() => {}} />);
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(ctrl.openCalls).toHaveLength(1);

  // Wait for heartbeat ping (1000ms) to trigger kicked error, plus past 800ms auto-reconnect delay
  await act(async () => {
    const deadline = Date.now() + 2400;
    while (getDesktopLive() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    await new Promise((done) => setTimeout(done, 900));
  });

  expect(getDesktopLive()).toBeFalse();
  expect(ctrl.openCalls).toHaveLength(1);
  expect(appRoot().querySelector(".rd-state-title")?.textContent).toBe(t("desktop.reason.kickedTitle"));
  expect(appRoot().querySelector(".rd-state-sub")?.textContent).toBe(t("desktop.reason.kickedSub"));
  expect(appRoot().querySelector("details.recovery-console")).toBeNull();
  const takeOverBtn = appRoot().querySelector<HTMLButtonElement>(".rd-state-actions .btn-primary");
  expect(takeOverBtn?.textContent).toBe(t("desktop.takeOver"));
});

test("locked auto-expands RecoveryConsole only when saved, and permission reasons show distinct guidance + status cmd", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: new ProtocolError("forbidden", "[reason:locked] desktop session is closed"),
    observation: { rtp_time: 101, healthy: true },
  };
  const host = seedConnectedP2P(ctrl);

  // 1) Locked without saved console URL -> RecoveryConsole rendered but collapsed
  await act(async () => {
    renderReact(<DesktopScreen />);
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(appRoot().querySelector(".rd-state-title")?.textContent).toBe(t("desktop.reason.lockedTitle"));
  const collapsedConsole = appRoot().querySelector<HTMLDetailsElement>("details.recovery-console");
  expect(collapsedConsole).not.toBeNull();
  expect(collapsedConsole?.hasAttribute("open")).toBeFalse();

  // 2) Locked WITH saved console URL -> RecoveryConsole auto-expanded
  saveConsole(host, "https://kvm.example.net/");
  ctrl.failNextOpen = new ProtocolError("forbidden", "[reason:locked] Mac screen locked");
  const reconnectBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-state-actions button")].find(
    (b) => b.textContent === t("desktop.reconnect"),
  )!;
  await act(async () => {
    reconnectBtn.click();
    await new Promise((done) => setTimeout(done, 25));
  });
  const expandedConsole = appRoot().querySelector<HTMLDetailsElement>("details.recovery-console");
  expect(expandedConsole).not.toBeNull();
  expect(expandedConsole?.hasAttribute("open")).toBeTrue();

  // 3) perm_screen -> Screen Recording guidance + pairfob desktop status, no RecoveryConsole
  ctrl.failNextOpen = new ProtocolError("forbidden", "[reason:perm_screen] Screen Recording missing");
  await act(async () => {
    appRoot().querySelector<HTMLButtonElement>(".rd-state-actions .btn-primary")!.click();
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(appRoot().querySelector(".rd-state-title")?.textContent).toBe(t("desktop.reason.permScreenTitle"));
  expect(appRoot().querySelector(".rd-state-sub")?.textContent).toBe(t("desktop.reason.permScreenSub"));
  expect(appRoot().querySelector(".rd-cmd-copy code")?.textContent).toBe("pairfob desktop status");
  expect(appRoot().querySelector("details.recovery-console")).toBeNull();

  // 4) perm_accessibility -> distinct Accessibility guidance + pairfob desktop status
  ctrl.failNextOpen = new ProtocolError("forbidden", "[reason:perm_accessibility] Accessibility missing");
  await act(async () => {
    appRoot().querySelector<HTMLButtonElement>(".rd-state-actions .btn-primary")!.click();
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(appRoot().querySelector(".rd-state-title")?.textContent).toBe(t("desktop.reason.permAccessibilityTitle"));
  expect(appRoot().querySelector(".rd-state-sub")?.textContent).toBe(t("desktop.reason.permAccessibilitySub"));
  expect(appRoot().querySelector(".rd-cmd-copy code")?.textContent).toBe("pairfob desktop status");
  expect(appRoot().querySelector("details.recovery-console")).toBeNull();
});

test("Screen Wake Lock is acquired on live and released on hidden, disconnect, and unmount", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);

  let requests = 0;
  let releases = 0;
  const sentinels: Array<{ released: boolean }> = [];
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      async request(type: string) {
        expect(type).toBe("screen");
        requests += 1;
        const sentinel = {
          released: false,
          async release() {
            if (!this.released) {
              this.released = true;
              releases += 1;
            }
          },
        };
        sentinels.push(sentinel);
        return sentinel;
      },
    },
  });

  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
  };
  seedConnectedP2P(ctrl);

  await act(async () => {
    renderReact(<DesktopScreen />);
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(requests).toBe(1);
  expect(releases).toBe(0);

  // Visibility hidden releases Wake Lock
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new happy.Event("visibilitychange") as unknown as Event);
    await Promise.resolve();
  });
  expect(releases).toBe(1);
  expect(sentinels[0].released).toBeTrue();

  // Returning to visible re-connects live stream and acquires a new Wake Lock
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new happy.Event("visibilitychange") as unknown as Event);
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(requests).toBe(2);
  expect(releases).toBe(1);

  // Manual disconnect releases Wake Lock
  const disconnectBtn = appRoot().querySelector<HTMLButtonElement>(`button[aria-label="${t("desktop.disconnect")}"]`)!;
  await act(async () => {
    disconnectBtn.click();
    await Promise.resolve();
  });
  expect(releases).toBe(2);
  expect(sentinels[1].released).toBeTrue();

  // Reconnect and unmount also releases Wake Lock
  const reconnectBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-state-actions button")].find(
    (b) => b.textContent === t("desktop.reconnect"),
  )!;
  await act(async () => {
    reconnectBtn.click();
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(requests).toBe(3);
  act(() => unmountReact());
  expect(releases).toBe(3);
  expect(sentinels[2].released).toBeTrue();
});

test("phone landscape HUD exposes quality/mode popover, diagnostics trigger, and attention pill", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  pointerState = { fine: false, coarse: true };
  Object.defineProperty(globalThis, "screen", { configurable: true, value: { width: 844, height: 390 } });
  happy.happyDOM.setWindowSize({ width: 844, height: 390 });

  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
  };
  seedConnectedP2P(ctrl);

  let attentionOpens = 0;
  await act(async () => {
    renderReact(
      <DesktopScreen
        onBack={() => {}}
        attentionCount={2}
        onOpenAttention={() => { attentionOpens += 1; }}
      />,
    );
    await new Promise((done) => setTimeout(done, 25));
  });

  // Topbar is hidden in phone landscape; floating HUD renders expanded toolbar
  expect(appRoot().querySelector(".rd-topbar")).toBeNull();
  const hud = appRoot().querySelector(".rd-floating-hud")!;
  expect(hud).not.toBeNull();

  // Diagnostics trigger opens stats popover
  const statsBtn = hud.querySelector<HTMLButtonElement>(`button[aria-label="${t("desktop.stats")}"]`)!;
  expect(statsBtn).not.toBeNull();
  act(() => { statsBtn.click(); });
  expect(appRoot().querySelector(`.rd-popover[aria-label="${t("desktop.stats")}"]`)).not.toBeNull();

  // Quality/mode trigger opens quality popover with mode toggle inside
  const qualityBtn = hud.querySelector<HTMLButtonElement>(`button[aria-label="${t("desktop.qualityAudio")}"]`)!;
  expect(qualityBtn).not.toBeNull();
  act(() => { qualityBtn.click(); });
  const qualityPop = appRoot().querySelector(`.rd-popover[aria-label="${t("desktop.qualityAudio")}"]`)!;
  expect(qualityPop).not.toBeNull();
  expect(qualityPop.textContent).toContain(t("desktop.modeControlShort"));

  // Attention pill is visible and releases inputs before invoking callback
  const attnBtn = hud.querySelector<HTMLButtonElement>(".rd-fp-attn")!;
  expect(attnBtn.querySelector(".rd-attn-pill")?.textContent).toBe(t("desktop.attention", { count: 2 }));
  act(() => { attnBtn.click(); });
  expect(attentionOpens).toBe(1);
  expect(ctrl.inputEvents.some((e) => e.kind === "release")).toBeTrue();

  // Collapsed HUD also keeps stats, attention pill, and quality/mode popover trigger accessible
  const collapseBtn = [...hud.querySelectorAll<HTMLButtonElement>(".rd-fp-btn")].find(
    (b) => b.textContent === t("desktop.hudCollapse"),
  )!;
  act(() => { collapseBtn.click(); });
  const collapsedHud = appRoot().querySelector(".rd-floating-hud")!;
  expect(collapsedHud.querySelector(`button[aria-label="${t("desktop.stats")}"]`)).not.toBeNull();
  expect(collapsedHud.querySelector(`button[aria-label="${t("desktop.qualityAudio")}"]`)).not.toBeNull();
  expect(collapsedHud.querySelector(".rd-fp-attn .rd-attn-pill")?.textContent).toBe(t("desktop.attention", { count: 2 }));
});
