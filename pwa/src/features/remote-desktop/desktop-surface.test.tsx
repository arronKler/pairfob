import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { PairResult } from "../../lib/protocol/client";
import type { DesktopEvent, DesktopObservation, DesktopRPC } from "../../lib/protocol/remote-desktop";
import type { LiveSession } from "../../lib/protocol/session-types";
import { attachLiveSession, setComputers, setCredential } from "../computers/catalog-store";
import { setNetworkMode, setPhase, setSessionTransport } from "../connection/connection-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { DESKTOP_PREFS_KEY, setDefaultAudio, setDefaultMode, setDefaultQuality, setTouchMode } from "./desktop-prefs";
import { getDesktopLive, setDesktopLive, useDesktopStatus } from "./desktop-status";
import { DesktopScreen } from "./desktop-surface";

type OpenCall = { control: boolean; audio: boolean; quality: string };
type MockSessionCtrl = {
  openCalls: OpenCall[];
  inputEvents: DesktopEvent[];
  closeCalls: number;
  failNextOpen: string | null;
  observation: DesktopObservation;
  pingFailures?: Array<Error | null>;
};

type FakePeerHandle = {
  connectionState: string;
  onconnectionstatechange?: () => void;
};

let savedRTC: unknown;
let savedMS: unknown;
let savedPlay: unknown;
let savedRVC: unknown;
let savedCancelRVC: unknown;
let savedMatchMedia: typeof window.matchMedia;
let latestPeer: FakePeerHandle | null = null;
let pointerState = { fine: true, coarse: false };
let fineListeners: Array<() => void> = [];
let coarseListeners: Array<() => void> = [];

function installFakeWebRTC(frameCallbackRef: { cb?: VideoFrameRequestCallback }): void {
  latestPeer = null;
  class FakePeerConnection extends EventTarget {
    iceGatheringState = "complete";
    connectionState = "connected";
    onconnectionstatechange?: () => void;
    localDescription = {
      type: "offer",
      sdp: "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ srflx\r\n",
    };
    constructor() {
      super();
      latestPeer = this;
    }
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

function setPointerProfile(fine: boolean, coarse: boolean): void {
  pointerState = { fine, coarse };
  for (const fn of [...fineListeners, ...coarseListeners]) fn();
}

function createFakeSession(ctrl: MockSessionCtrl): LiveSession {
  const desktop = (): DesktopRPC => ({
    async open(_sdp, control, audio, quality) {
      ctrl.openCalls.push({ control, audio, quality });
      if (ctrl.failNextOpen) {
        const msg = ctrl.failNextOpen;
        ctrl.failNextOpen = null;
        throw new Error(msg);
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
    deviceId: "dev_surf1234",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: "d_surf1234567890123",
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "Browser",
    createdAt: 1_700_000_000_000,
    hostname: "MacBook Pro",
    lastSeen: 1_700_000_000_000,
  };
}

function seedConnectedP2P(ctrl: MockSessionCtrl, caps: Partial<Record<keyof typeof NO_OPERATION_CAPABILITIES, boolean>> = {}) {
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
    ...caps,
  }, []);
  attachLiveSession(createFakeSession(ctrl));
}

function StatusProbe({ onRead }: { onRead: (status: ReturnType<typeof useDesktopStatus>) => void }) {
  onRead(useDesktopStatus());
  return null;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  savedMatchMedia = window.matchMedia.bind(window);
  fineListeners = [];
  coarseListeners = [];
  pointerState = { fine: true, coarse: false };
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  installPointerMatchMedia();
  setLang("zh");
  localStorage.removeItem(DESKTOP_PREFS_KEY);
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
  setDesktopLive(false);
  attachLiveSession(null);
  setComputers([]);
  setCredential(null);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  localStorage.removeItem(DESKTOP_PREFS_KEY);
});

test("1-tap auto-connect skips setup form, uses saved prefs, updates status, and seamlessly reconnects on mode/quality switch", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  setDefaultMode("view");
  setDefaultQuality("detail");
  setDefaultAudio(true);

  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
  };
  seedConnectedP2P(ctrl);

  let latestStatus: ReturnType<typeof useDesktopStatus> | null = null;
  await act(async () => {
    renderReact(
      <>
        <DesktopScreen />
        <StatusProbe onRead={(s) => { latestStatus = s; }} />
      </>,
    );
    await new Promise((done) => setTimeout(done, 25));
  });

  // Never renders a <dialog> modal or pre-connect setup form
  expect(appRoot().querySelector("dialog")).toBeNull();
  expect(ctrl.openCalls).toEqual([{ control: false, audio: true, quality: "detail" }]);
  expect(getDesktopLive()).toBeTrue();
  expect(latestStatus).toEqual({ pip: "live", live: true, supported: true });

  // Switch from View to Control on topbar -> triggers close + open reconnect
  const controlOption = [...appRoot().querySelectorAll<HTMLButtonElement>('.rd-mode-seg [role="radio"]')].find(
    (b) => b.textContent === t("desktop.modeControlShort"),
  )!;
  await act(async () => {
    controlOption.click();
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(ctrl.closeCalls).toBe(1);
  expect(ctrl.openCalls).toEqual([
    { control: false, audio: true, quality: "detail" },
    { control: true, audio: true, quality: "detail" },
  ]);

  // Open Quality & Audio popover and switch quality to "motion" -> seamless close + open
  const qualityBtn = appRoot().querySelector<HTMLButtonElement>(`button[aria-label="${t("desktop.qualityAudio")}"]`)!;
  act(() => { qualityBtn.click(); });
  const motionOption = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-pop-option")].find(
    (b) => b.textContent?.includes(t("desktop.motion")),
  )!;
  await act(async () => {
    motionOption.click();
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(ctrl.closeCalls).toBe(2);
  expect(ctrl.openCalls.at(-1)).toEqual({ control: true, audio: true, quality: "motion" });
});

test("preflight cards: relay triggers onRetryDirect, unsupported shows setup cmd, error/disconnect embeds RecoveryConsole + Reconnect", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
  };
  seedConnectedP2P(ctrl, { view_desktop: false });

  let retries = 0;
  let backs = 0;
  let settingsOpens = 0;

  // 1) Host without view_desktop -> setup guide + copyable command
  await act(async () => {
    renderReact(
      <DesktopScreen
        onBack={() => { backs += 1; }}
        onOpenSettings={() => { settingsOpens += 1; }}
        onRetryDirect={() => { retries += 1; }}
      />,
    );
    await Promise.resolve();
  });
  expect(ctrl.openCalls).toHaveLength(0);
  expect(appRoot().textContent).toContain(t("desktop.preflightUnsupportedTitle"));
  expect(appRoot().querySelector(".rd-cmd-copy code")?.textContent).toBe("pairfob desktop setup");

  const settingsBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-state-actions button")].find(
    (b) => b.textContent === t("desktop.openSettings"),
  )!;
  act(() => { settingsBtn.click(); });
  expect(settingsOpens).toBe(1);

  // 2) Relay transport -> 1-click retry direct callback
  await act(async () => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: true, control_desktop: true }, []);
    setSessionTransport("relay");
    await Promise.resolve();
  });
  expect(ctrl.openCalls).toHaveLength(0);
  expect(appRoot().textContent).toContain(t("desktop.relayTitle"));
  const retryBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-state-actions button")].find(
    (b) => b.textContent?.includes(t("desktop.retryDirect")),
  )!;
  act(() => { retryBtn.click(); });
  expect(retries).toBe(1);

  // 3) Error on open -> disconnected card with error cause, RecoveryConsole, Reconnect & Back
  ctrl.failNextOpen = "Mac screen locked";
  await act(async () => {
    setSessionTransport("p2p");
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(appRoot().querySelector(".rd-state-title")?.textContent).toBe("Mac screen locked");
  expect(appRoot().querySelector("details.recovery-console")).not.toBeNull();

  const reconnectBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-state-actions button")].find(
    (b) => b.textContent === t("desktop.reconnect"),
  )!;
  await act(async () => {
    reconnectBtn.click();
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(ctrl.openCalls).toHaveLength(2);

  // Visibility hidden auto-stops stream & displays disconnected card with Back
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new happy.Event("visibilitychange") as unknown as Event);
    await Promise.resolve();
  });
  expect(getDesktopLive()).toBeFalse();
  expect(ctrl.closeCalls).toBeGreaterThanOrEqual(1);
  expect(appRoot().querySelector("details.recovery-console")).not.toBeNull();
  const backBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-state-actions button")].find(
    (b) => b.textContent === t("desktop.back"),
  )!;
  act(() => { backBtn.click(); });
  expect(backs).toBe(1);
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

test("tablet touch shows floating HUD and hides it when hardware keyboard or fine pointer takes over", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
  setPointerProfile(false, true);

  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
  };
  seedConnectedP2P(ctrl);

  await act(async () => {
    renderReact(<DesktopScreen onBack={() => {}} onToggleRail={() => {}} />);
    await new Promise((done) => setTimeout(done, 25));
  });

  // Tablet touch: floating HUD visible, desktop shortcuts button & kb-hint hidden
  expect(appRoot().querySelector(".rd-floating-hud")).not.toBeNull();
  expect(appRoot().querySelector(".rd-kb-hint")).toBeNull();
  expect([...appRoot().querySelectorAll(".rd-topbar button")].some((b) => b.textContent?.includes(t("desktop.shortcuts")))).toBeFalse();

  // Connecting a fine pointer / hardware mouse + keyboard on tablet hides touch HUD and reveals kb hint & shortcuts
  act(() => {
    setPointerProfile(true, true);
    document.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "a", bubbles: true }) as unknown as Event);
  });
  expect(appRoot().querySelector(".rd-floating-hud")).toBeNull();
  expect(appRoot().querySelector(".rd-kb-hint")?.textContent).toBe(t("desktop.kbHint"));
  expect([...appRoot().querySelectorAll(".rd-topbar button")].some((b) => b.textContent?.includes(t("desktop.shortcuts")))).toBeTrue();

  // Switching to phone landscape (640x360, touch) hides topbar and shows floating HUD with Back/Power
  await act(async () => {
    setPointerProfile(false, true);
    happy.happyDOM.setWindowSize({ width: 640, height: 360 });
    await Promise.resolve();
  });
  expect(appRoot().querySelector(".rd-topbar")).toBeNull();
  expect(appRoot().querySelector(".rd-floating-hud")).not.toBeNull();
  expect(appRoot().querySelector(`button[aria-label="${t("desktop.back")}"]`)).not.toBeNull();
  expect(appRoot().querySelector(`button[aria-label="${t("desktop.disconnect")}"]`)).not.toBeNull();
});

test("1.8s frame stall shows frozen protection veil and blocks input", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 999, healthy: false },
  };
  seedConnectedP2P(ctrl);

  await act(async () => {
    renderReact(<DesktopScreen />);
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(appRoot().querySelector(".rd-frozen-veil")).toBeNull();

  // Wait past the 1.8s frame stall window across heartbeat ticks (1s, 2s)
  await act(async () => {
    const deadline = Date.now() + 3200;
    while (!appRoot().querySelector(".rd-frozen-veil") && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
  });

  expect(appRoot().querySelector(".rd-frozen-veil")?.textContent).toContain(t("desktop.stalledBanner"));
  expect(appRoot().querySelector(".rd-metric-pill.is-warn")?.textContent).toBe(t("desktop.stalledChip"));
});

test("window blur releases inputs without disconnecting, and visibility return auto-reconnects", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
  };
  seedConnectedP2P(ctrl);

  await act(async () => {
    renderReact(<DesktopScreen onBack={() => {}} />);
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(ctrl.openCalls).toHaveLength(1);

  // Blur (e.g. Control Center / notification / alt-tab) must NOT drop the stream; only sends release
  await act(async () => {
    window.dispatchEvent(new happy.Event("blur") as unknown as Event);
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(ctrl.closeCalls).toBe(0);
  expect(ctrl.inputEvents.some((e) => e.kind === "release")).toBeTrue();

  // Backgrounding pauses cleanly; returning to foreground auto-reconnects with zero user taps
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new happy.Event("visibilitychange") as unknown as Event);
    await Promise.resolve();
  });
  expect(getDesktopLive()).toBeFalse();
  expect(ctrl.closeCalls).toBe(1);

  await act(async () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new happy.Event("visibilitychange") as unknown as Event);
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(ctrl.openCalls).toHaveLength(2);
});

test("transient peer drop auto-reconnects seamlessly, while brief ICE disconnected recovers and manual disconnect stays off", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
    pingFailures: [new Error("transient timeout")],
  };
  seedConnectedP2P(ctrl);

  await act(async () => {
    renderReact(<DesktopScreen onBack={() => {}} />);
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(ctrl.openCalls).toHaveLength(1);

  // Transient ICE "disconnected" -> recovers to "connected" within grace window without dropping
  act(() => {
    latestPeer!.connectionState = "disconnected";
    latestPeer!.onconnectionstatechange?.();
  });
  expect(getDesktopLive()).toBeTrue();
  expect(appRoot().querySelector(".rd-frozen-veil")).not.toBeNull();
  act(() => {
    latestPeer!.connectionState = "connected";
    latestPeer!.onconnectionstatechange?.();
  });
  expect(getDesktopLive()).toBeTrue();
  expect(appRoot().querySelector(".rd-frozen-veil")).toBeNull();

  // Hard ICE failure -> enters auto-reconnecting and automatically restores stream without user tap
  await act(async () => {
    latestPeer!.connectionState = "failed";
    latestPeer!.onconnectionstatechange?.();
    await Promise.resolve();
  });
  expect(getDesktopLive()).toBeFalse();
  expect(appRoot().textContent).toContain(t("desktop.reconnectingHost", { host: "MacBook Pro" }));

  await act(async () => {
    await new Promise((done) => setTimeout(done, 900));
  });
  expect(getDesktopLive()).toBeTrue();
  expect(ctrl.openCalls).toHaveLength(2);

  // Explicit user disconnect must NOT auto-reconnect
  const disconnectBtn = appRoot().querySelector<HTMLButtonElement>(`button[aria-label="${t("desktop.disconnect")}"]`)!;
  await act(async () => {
    disconnectBtn.click();
    await new Promise((done) => setTimeout(done, 900));
  });
  expect(getDesktopLive()).toBeFalse();
  expect(ctrl.openCalls).toHaveLength(2);
  expect(appRoot().textContent).toContain(t("desktop.disconnectedTitle"));
});

test("phone portrait compact topbar avoids nested box, shows clear mode capsule, and view-only HUD hides touchpad toggle", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  setPointerProfile(false, true);
  setDefaultMode("view");

  const ctrl: MockSessionCtrl = {
    openCalls: [],
    inputEvents: [],
    closeCalls: 0,
    failNextOpen: null,
    observation: { rtp_time: 101, healthy: true },
  };
  seedConnectedP2P(ctrl);

  await act(async () => {
    renderReact(<DesktopScreen onBack={() => {}} attentionCount={1} onOpenAttention={() => {}} />);
    await new Promise((done) => setTimeout(done, 25));
  });

  const bar = appRoot().querySelector(".rd-topbar.is-compact")!;
  expect(bar).not.toBeNull();
  expect(bar.querySelector(".rd-host-chip.is-compact .rd-metric-pill")).not.toBeNull();
  expect(bar.querySelector(".rd-host-chip-name")).toBeNull();
  expect(bar.querySelector(".rd-attn-btn .rd-attn-pill")?.textContent).toBe(t("desktop.attention", { count: 1 }));
  expect(bar.querySelector(".rd-mode-btn .rd-mode-pill")?.textContent).toBe(t("desktop.modeViewCompact"));

  // In view-only mode on phone portrait, floating HUD must NOT show the touchpad toggle
  const hud = appRoot().querySelector(".rd-floating-hud")!;
  expect(hud).not.toBeNull();
  expect(hud.textContent).not.toContain(t("desktop.trackpad"));
  expect(hud.textContent).not.toContain(t("desktop.directTap"));
  expect(hud.textContent).toContain(t("desktop.fit"));
});
