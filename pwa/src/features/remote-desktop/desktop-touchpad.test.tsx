import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { expectDifferentNode } from "../../../test-support/node-identity";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { PairResult } from "../../lib/protocol/client";
import type { DesktopEvent, DesktopRPC } from "../../lib/protocol/remote-desktop";
import type { LiveSession } from "../../lib/protocol/session-types";
import { attachLiveSession, setComputers, setCredential } from "../computers/catalog-store";
import { setNetworkMode, setPhase, setSessionTransport } from "../connection/connection-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { DESKTOP_PREFS_KEY, setDefaultAudio, setDefaultMode, setDefaultQuality, setTouchMode } from "./desktop-prefs";
import { setDesktopLive } from "./desktop-status";
import { DesktopIme } from "./desktop-ime";
import { DesktopScreen } from "./desktop-surface";
import { DesktopTouchpad } from "./desktop-touchpad";

type MockPeerState = {
  openCalls: Array<{ control: boolean; audio: boolean; quality: string }>;
  inputEvents: DesktopEvent[];
  closeCalls: number;
};

let savedRTC: unknown;
let savedMS: unknown;
let savedPlay: unknown;
let savedRVC: unknown;
let savedCancelRVC: unknown;
let savedMatchMedia: typeof window.matchMedia;

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

function installTouchMatchMedia(): void {
  const baseMatch = savedMatchMedia;
  const overridden = (query: string): MediaQueryList => {
    if (query.includes("pointer: fine")) {
      const list = new EventTarget() as MediaQueryList;
      return Object.assign(list, { matches: false, media: query, onchange: null, addListener() {}, removeListener() {} });
    }
    if (query.includes("any-pointer: coarse")) {
      const list = new EventTarget() as MediaQueryList;
      return Object.assign(list, { matches: true, media: query, onchange: null, addListener() {}, removeListener() {} });
    }
    return baseMatch(query);
  };
  window.matchMedia = overridden;
  globalThis.matchMedia = overridden;
}

function createFakeSession(state: MockPeerState): LiveSession {
  const desktop = (): DesktopRPC => ({
    async open(_sdp, control, audio, quality) {
      state.openCalls.push({ control, audio, quality });
      return { sdp: "v=0\r\n", display: "Built-in Retina 16\"" };
    },
    async ping() { return { rtp_time: 101, healthy: true, encode_ms: 2 }; },
    async input(event) { state.inputEvents.push(event); },
    async close() { state.closeCalls += 1; },
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
    deviceId: "dev_touch1234",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: "d_touch123456789012",
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "Phone",
    createdAt: 1_700_000_000_000,
    hostname: "MacBook Pro",
    lastSeen: 1_700_000_000_000,
  };
}

function pointerEvent(type: string, opts: { clientX?: number; clientY?: number; pointerId?: number; pointerType?: string } = {}) {
  return new happy.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: opts.pointerId ?? 1,
    pointerType: opts.pointerType ?? "touch",
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  savedMatchMedia = window.matchMedia.bind(window);
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  installTouchMatchMedia();
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

test("DesktopTouchpad removes .rd-scroll-rail, supports two-finger scroll/tap without accidental left-click, and handles cursor/buttons", async () => {
  const sent: DesktopEvent[] = [];
  let cursor = { x: 0.5, y: 0.5 };
  let dragLock = false;
  let dragLockClicks = 0;

  const renderPad = () => {
    act(() => renderReact(
      <DesktopTouchpad
        canControl
        stalled={false}
        zoom={1}
        imeOpen={false}
        dragLock={dragLock}
        cursor={cursor}
        onCursorMove={(next) => { cursor = next; }}
        onSend={(ev) => { sent.push(ev); return true; }}
        onToggleIme={() => {}}
        onToggleZoom={() => {}}
        onSwitchDirect={() => {}}
        onToggleDragLock={() => { dragLockClicks += 1; dragLock = !dragLock; }}
      />,
    ));
  };
  renderPad();

  // .rd-scroll-rail is completely removed in favor of two-finger gestures
  expect(appRoot().querySelector(".rd-scroll-rail")).toBeNull();
  expect(appRoot().querySelector(".rd-tp-sub")?.textContent).toBe(t("desktop.trackpadTwoFingerSub"));

  const surface = appRoot().querySelector<HTMLElement>(".rd-trackpad-surface")!;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });

  // Drag moves cursor without firing a click
  act(() => {
    surface.dispatchEvent(pointerEvent("pointerdown", { clientX: 40, clientY: 40 }));
    surface.dispatchEvent(pointerEvent("pointermove", { clientX: 80, clientY: 60 }));
    surface.dispatchEvent(pointerEvent("pointerup", { clientX: 80, clientY: 60 }));
  });
  expect(sent.map((e) => e.kind)).toEqual(["move"]);
  expect(cursor.x).toBeCloseTo(0.7, 3);
  expect(cursor.y).toBeCloseTo(0.7, 3);

  // Tap without drag emits left click down + up
  sent.length = 0;
  renderPad();
  act(() => {
    surface.dispatchEvent(pointerEvent("pointerdown", { clientX: 50, clientY: 50 }));
    surface.dispatchEvent(pointerEvent("pointerup", { clientX: 50, clientY: 50 }));
  });
  expect(sent).toEqual([
    { kind: "down", x: cursor.x, y: cursor.y, button: "left" },
    { kind: "up", x: cursor.x, y: cursor.y, button: "left" },
  ]);

  // Two-finger drag emits scroll events and does NOT move cursor or trigger clicks on sequential lift
  sent.length = 0;
  const beforeCursor = { ...cursor };
  act(() => {
    surface.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, clientX: 100, clientY: 20 }));
    surface.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, clientX: 130, clientY: 20 }));
    surface.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, clientX: 100, clientY: 55 }));
    surface.dispatchEvent(pointerEvent("pointermove", { pointerId: 2, clientX: 130, clientY: 55 }));
    surface.dispatchEvent(pointerEvent("pointerup", { pointerId: 1, clientX: 100, clientY: 55 }));
    surface.dispatchEvent(pointerEvent("pointerup", { pointerId: 2, clientX: 130, clientY: 55 }));
  });
  expect(cursor).toEqual(beforeCursor);
  expect(sent).toEqual([
    { kind: "scroll", x: cursor.x, y: cursor.y, dx: 0, dy: -35 },
    { kind: "scroll", x: cursor.x, y: cursor.y, dx: 0, dy: -35 },
  ]);

  // Two-finger quick tap emits right-click and NEVER emits an accidental left-click when fingers lift sequentially
  sent.length = 0;
  act(() => {
    surface.dispatchEvent(pointerEvent("pointerdown", { pointerId: 11, clientX: 90, clientY: 50 }));
    surface.dispatchEvent(pointerEvent("pointerdown", { pointerId: 12, clientX: 120, clientY: 50 }));
    surface.dispatchEvent(pointerEvent("pointermove", { pointerId: 11, clientX: 91, clientY: 51 }));
    surface.dispatchEvent(pointerEvent("pointerup", { pointerId: 11, clientX: 91, clientY: 51 }));
  });
  expect(sent).toEqual([]);
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
    surface.dispatchEvent(pointerEvent("pointerup", { pointerId: 12, clientX: 120, clientY: 50 }));
  });
  expect(sent).toEqual([
    { kind: "down", x: cursor.x, y: cursor.y, button: "right" },
    { kind: "up", x: cursor.x, y: cursor.y, button: "right" },
  ]);

  // Bottom buttons: left, drag-lock, right
  sent.length = 0;
  const buttons = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-tp-buttons .rd-tp-btn")];
  expect(buttons).toHaveLength(3);
  act(() => { buttons[0].click(); });
  act(() => { buttons[2].click(); });
  expect(sent).toEqual([
    { kind: "down", x: cursor.x, y: cursor.y, button: "left" },
    { kind: "up", x: cursor.x, y: cursor.y, button: "left" },
    { kind: "down", x: cursor.x, y: cursor.y, button: "right" },
    { kind: "up", x: cursor.x, y: cursor.y, button: "right" },
  ]);

  // Drag lock suppresses tap-click on pointerup
  act(() => { buttons[1].click(); });
  expect(dragLockClicks).toBe(1);
  renderPad();
  expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
  sent.length = 0;
  act(() => {
    surface.dispatchEvent(pointerEvent("pointerdown", { clientX: 50, clientY: 50 }));
    surface.dispatchEvent(pointerEvent("pointerup", { clientX: 50, clientY: 50 }));
  });
  expect(sent).toEqual([]);
});

test("phone portrait DesktopScreen supports drag-lock lease, 2x zoom minimap, and switch to direct-tap HUD", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const state: MockPeerState = { openCalls: [], inputEvents: [], closeCalls: 0 };
  const host = sampleHost();
  setComputers([host]);
  setCredential(host);
  setPhase("live");
  setNetworkMode("auto");
  setSessionTransport("p2p");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: true, control_desktop: true }, []);
  attachLiveSession(createFakeSession(state));

  await act(async () => {
    renderReact(<DesktopScreen />);
    await new Promise((done) => setTimeout(done, 20));
  });

  // Split touchpad should be mounted on phone portrait + touch
  expect(appRoot().querySelector(".rd-touch-dock")).not.toBeNull();
  expect(appRoot().querySelector(".rd-floating-hud")).toBeNull();

  // Drag-lock sends left down; toggling off sends left up
  const dragLockBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-tp-btn")].find(
    (b) => b.textContent === t("desktop.dragLock"),
  )!;
  await act(async () => { dragLockBtn.click(); await Promise.resolve(); });
  expect(dragLockBtn.getAttribute("aria-pressed")).toBe("true");
  expect(state.inputEvents.at(-1)).toEqual({ kind: "down", x: 0.5, y: 0.5, button: "left" });

  await act(async () => { dragLockBtn.click(); await Promise.resolve(); });
  expect(dragLockBtn.getAttribute("aria-pressed")).toBe("false");
  expect(state.inputEvents.at(-1)).toEqual({ kind: "up", x: 0.5, y: 0.5, button: "left" });

  // 2x zoom enables canvas transform and minimap
  const zoomBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-qchip")].find(
    (b) => b.textContent?.includes(t("desktop.zoom2x")),
  )!;
  expect(appRoot().querySelector(".rd-zoom-minimap")).toBeNull();
  act(() => { zoomBtn.click(); });
  expect(appRoot().querySelector(".rd-zoom-minimap")).not.toBeNull();
  expect(appRoot().querySelector<HTMLElement>(".rd-canvas")?.style.transform).toContain("scale(2)");

  // Switch to direct-tap mode swaps touchpad dock for floating HUD
  const directBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-qchip")].find(
    (b) => b.textContent?.includes(t("desktop.directTap")),
  )!;
  act(() => { directBtn.click(); });
  expect(appRoot().querySelector(".rd-touch-dock")).toBeNull();
  expect(appRoot().querySelector(".rd-floating-hud")).not.toBeNull();
});

test("DesktopIme never auto-focuses, guards IME composition, submits text, and latches modifiers", () => {
  const sent: DesktopEvent[] = [];
  let closed = 0;

  act(() => renderReact(
    <DesktopIme
      disabled={false}
      onSend={(ev) => { sent.push(ev); return true; }}
      onClose={() => { closed += 1; }}
    />,
  ));

  const input = appRoot().querySelector<HTMLInputElement>(".rd-ime-input")!;
  expect(input).not.toBeNull();
  expectDifferentNode(document.activeElement, input);

  // Enter while composing is prevented; typing and submitting sends { kind: "text", text }
  const form = input.form!;
  const sendBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let composingEnter!: KeyboardEvent;
  act(() => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, "中文");
    input.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    composingEnter = new happy.KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }) as unknown as KeyboardEvent;
    input.dispatchEvent(composingEnter);
  });
  expect(composingEnter.defaultPrevented).toBeTrue();
  expect(sent).toEqual([]);

  let plainEnter!: KeyboardEvent;
  act(() => {
    plainEnter = new happy.KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: false,
      bubbles: true,
      cancelable: true,
    }) as unknown as KeyboardEvent;
    input.dispatchEvent(plainEnter);
    sendBtn.click();
  });
  expect(plainEnter.defaultPrevented).toBeFalse();
  expect(sent).toEqual([{ kind: "text", text: "中文" }]);
  expect(input.value).toBe("");

  // Latch modifiers (⌘ and ⇧ -> 8 | 1 = 9) and combine with Tab, then verify latches reset
  sent.length = 0;
  const cmdBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-sc-key")].find((b) => b.textContent === "⌘")!;
  const shiftBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-sc-key")].find((b) => b.textContent === "⇧")!;
  const tabBtn = appRoot().querySelector<HTMLButtonElement>('button[aria-label="Tab"]')!;

  act(() => { cmdBtn.click(); shiftBtn.click(); });
  expect(cmdBtn.getAttribute("aria-pressed")).toBe("true");
  expect(shiftBtn.getAttribute("aria-pressed")).toBe("true");

  act(() => { tabBtn.click(); });
  expect(sent).toEqual([{ kind: "key", code: "Tab", modifiers: 9 }]);
  expect(cmdBtn.getAttribute("aria-pressed")).toBe("false");
  expect(shiftBtn.getAttribute("aria-pressed")).toBe("false");

  // Direct shortcut button
  const copyBtn = appRoot().querySelector<HTMLButtonElement>('button[aria-label="Command C"]')!;
  act(() => { copyBtn.click(); });
  expect(sent.at(-1)).toEqual({ kind: "key", code: "KeyC", modifiers: 8 });

  const closeBtn = appRoot().querySelector<HTMLButtonElement>(`button[aria-label="${t("desktop.close")}"]`)!;
  act(() => { closeBtn.click(); });
  expect(closed).toBe(1);
});

test("split-touchpad idle video supports scoped pinch-zoom and double-tap zoom without interfering with touchpad", async () => {
  const frameCb: { cb?: VideoFrameRequestCallback } = {};
  installFakeWebRTC(frameCb);
  const state: MockPeerState = { openCalls: [], inputEvents: [], closeCalls: 0 };
  const host = sampleHost();
  setComputers([host]);
  setCredential(host);
  setPhase("live");
  setNetworkMode("auto");
  setSessionTransport("p2p");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: true, control_desktop: true }, []);
  attachLiveSession(createFakeSession(state));

  await act(async () => {
    renderReact(<DesktopScreen />);
    await new Promise((done) => setTimeout(done, 20));
  });

  const stage = appRoot().querySelector<HTMLElement>(".rd-stage")!;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 300, right: 390, bottom: 300, x: 0, y: 0, toJSON() {} });
  const canvas = appRoot().querySelector<HTMLElement>(".rd-canvas")!;
  expect(canvas.style.touchAction).toBe("none");

  // 1) Pinch-to-zoom from 1x to 2x on idle video canvas
  act(() => {
    canvas.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, clientX: 100, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, clientX: 200, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, clientX: 50, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointermove", { pointerId: 2, clientX: 250, clientY: 150 }));
  });
  expect(canvas.classList.contains("is-gesturing")).toBeTrue();
  expect(canvas.style.transform).toContain("scale(2)");
  expect(appRoot().querySelector(".rd-zoom-minimap")).not.toBeNull();

  act(() => {
    canvas.dispatchEvent(pointerEvent("pointerup", { pointerId: 1, clientX: 50, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointerup", { pointerId: 2, clientX: 250, clientY: 150 }));
  });
  expect(canvas.classList.contains("is-gesturing")).toBeFalse();
  expect(state.inputEvents).toEqual([]);

  // Touchpad controls still work independently while zoomed
  const pad = appRoot().querySelector<HTMLElement>(".rd-trackpad-surface")!;
  pad.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} });
  await act(async () => {
    pad.dispatchEvent(pointerEvent("pointerdown", { pointerId: 3, clientX: 40, clientY: 40 }));
    pad.dispatchEvent(pointerEvent("pointermove", { pointerId: 3, clientX: 60, clientY: 40 }));
    pad.dispatchEvent(pointerEvent("pointerup", { pointerId: 3, clientX: 60, clientY: 40 }));
    await new Promise((done) => setTimeout(done, 25));
  });
  expect(state.inputEvents.map((e) => e.kind)).toEqual(["move"]);

  // 2) Double-tap resets from 2x back to 1x, and double-tap again zooms to 2.5x
  act(() => {
    canvas.dispatchEvent(pointerEvent("pointerdown", { pointerId: 4, clientX: 150, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointerup", { pointerId: 4, clientX: 150, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointerdown", { pointerId: 4, clientX: 152, clientY: 152 }));
    canvas.dispatchEvent(pointerEvent("pointerup", { pointerId: 4, clientX: 152, clientY: 152 }));
  });
  expect(canvas.style.transform).toBe("");
  expect(appRoot().querySelector(".rd-zoom-minimap")).toBeNull();

  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
    canvas.dispatchEvent(pointerEvent("pointerdown", { pointerId: 5, clientX: 150, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointerup", { pointerId: 5, clientX: 150, clientY: 150 }));
    canvas.dispatchEvent(pointerEvent("pointerdown", { pointerId: 5, clientX: 151, clientY: 151 }));
    canvas.dispatchEvent(pointerEvent("pointerup", { pointerId: 5, clientX: 151, clientY: 151 }));
  });
  expect(canvas.style.transform).toContain("scale(2.5)");
  expect(appRoot().querySelector(".rd-zoom-minimap")).not.toBeNull();

  // Switching to direct-tap mode disables canvas gesture zoom so screen-input owns touch
  const directBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-qchip")].find(
    (b) => b.textContent?.includes(t("desktop.directTap")),
  )!;
  act(() => { directBtn.click(); });
  expect(appRoot().querySelector(".rd-touch-dock")).toBeNull();
  expect(canvas.style.touchAction).toBe("");
});
