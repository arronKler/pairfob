import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { openDesktop, leaveDesktop } from "../../app/desktop-nav";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { commitView } from "../../app/host";
import { mountApp, unmountApp } from "../../app/mount";
import { currentScreen, setDesktopFrom, setDesktopRailCollapsed, setScreen } from "../../app/navigation-store";
import { setLang, t } from "../../lib/i18n";
import { MOTION_MS } from "../../shared/ui/dom/motion";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { PairResult } from "../../lib/protocol/client";
import type { DesktopRPC } from "../../lib/protocol/remote-desktop";
import type { LiveSession } from "../../lib/protocol/session-types";
import { attachLiveSession, setComputers, setCredential } from "../computers/catalog-store";
import { setNetworkMode, setPhase, setSessionTransport } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { openPaneId, selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { registerSessionView } from "../session/register";
import { setSettingsSection } from "../settings/settings-section";
import { DESKTOP_PREFS_KEY, setDefaultAudio, setDefaultMode, setDefaultQuality, setTouchMode } from "./desktop-prefs";
import { setDesktopLive } from "./desktop-status";

let savedRTC: unknown;
let savedMS: unknown;
let savedPlay: unknown;
let savedRVC: unknown;
let savedCancelRVC: unknown;
let savedMatchMedia: typeof window.matchMedia;
let pointerState = { fine: false, coarse: true };

function installFakeWebRTC(): void {
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
    this.dispatchEvent(new happy.Event("playing"));
  };
  proto.requestVideoFrameCallback = () => 1;
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
  const overridden = (query: string): MediaQueryList => {
    if (query.includes("pointer: fine")) {
      const list = new EventTarget() as MediaQueryList;
      return Object.assign(list, { get matches() { return pointerState.fine; }, media: query, onchange: null, addListener() {}, removeListener() {} });
    }
    if (query.includes("any-pointer: coarse")) {
      const list = new EventTarget() as MediaQueryList;
      return Object.assign(list, { get matches() { return pointerState.coarse; }, media: query, onchange: null, addListener() {}, removeListener() {} });
    }
    return baseMatch(query);
  };
  window.matchMedia = overridden;
  globalThis.matchMedia = overridden;
}

function createFakeSession(calls: string[]): LiveSession {
  const desktop = (): DesktopRPC => ({
    async open() { return { sdp: "v=0\r\n", display: "Retina 16\"" }; },
    async ping() { return { rtp_time: 100, healthy: true }; },
    async input() {},
    async close() {},
  });
  return {
    desktop,
    isConnected: () => true,
    isChecking: () => false,
    connectionPhase: () => "connected",
    onEvent: () => () => {},
    snapshot: async () => ({}),
    paneRead: async () => ({ text: "prompt> ", hash: "a".repeat(64), truncated: false }),
    listDevices: async () => ({ devices: [] }),
    agentQuota: async () => ({ accounts: [], legacy: false, unknown: 0 }),
    daemonUpdateStatus: async () => ({ available: false, phase: "idle", target: "", operation_id: "" }),
    terminalResize: async () => { calls.push("terminalResize"); },
  } as unknown as LiveSession;
}

function seedApp(calls: string[]) {
  const host: PairResult = {
    deviceId: "dev_nav1234",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: "d_nav12345678901234",
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "Phone",
    createdAt: 1_700_000_000_000,
    hostname: "MacBook Pro",
    lastSeen: 1_700_000_000_000,
  };
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
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/work/pairfob" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob", agent: "codex", agent_status: "idle", label: "Task 1" }],
  });
  attachLiveSession(createFakeSession(calls));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  await (await import("../../app/connected-loader")).loadConnectedRuntime();
  savedMatchMedia = window.matchMedia.bind(window);
  pointerState = { fine: false, coarse: true };
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  installPointerMatchMedia();
  installFakeWebRTC();
  setLang("zh");
  localStorage.removeItem(DESKTOP_PREFS_KEY);
  setDefaultMode("control");
  setDefaultQuality("balanced");
  setDefaultAudio(false);
  setTouchMode("trackpad");
  setDesktopLive(false);
  setScreen("home");
  setDesktopFrom("home");
  setDesktopRailCollapsed(null);
  setSettingsSection("overview");
  registerSessionOwnerPreparer(registerSessionView);
});

afterEach(async () => {
  await act(async () => {
    unmountApp();
    registerSessionOwnerPreparer(null);
    await Promise.resolve();
  });
  uninstallFakeWebRTC();
  window.matchMedia = savedMatchMedia;
  globalThis.matchMedia = savedMatchMedia;
  setDesktopLive(false);
  attachLiveSession(null);
  setComputers([]);
  setCredential(null);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  selectPane("");
  setAgentChat(false);
  setFullTerminal(false);
  localStorage.removeItem(DESKTOP_PREFS_KEY);
});

test("phone 4-Tab Bar hides when desktop is live and stays visible in preflight and disconnected states", async () => {
  const calls: string[] = [];
  act(() => {
    seedApp(calls);
    mountApp();
  });

  // 4 tabs on phone home when host advertises view_desktop, with Desktop in the 3rd slot (after Board)
  const tabs = [...appRoot().querySelectorAll<HTMLButtonElement>(".tab-bar .tab-bar-item")];
  expect(tabs).toHaveLength(4);
  expect(tabs.map((b) => b.textContent)).toEqual([t("tabs.sessions"), t("tabs.board"), t("tabs.desktop"), t("tabs.settings")]);

  // Relay preflight keeps 4-Tab Bar visible
  await act(async () => {
    setSessionTransport("relay");
    tabs[2].click();
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(currentScreen()).toBe("desktop");
  expect(appRoot().textContent).toContain(t("desktop.relayTitle"));
  const relayBar = appRoot().querySelector(".tab-bar");
  expect(relayBar).not.toBeNull();
  expect(relayBar?.classList.contains("is-leaving")).toBeFalse();

  // Switch to P2P -> auto-connects live -> phone TabBar enters .is-leaving and unmounts after MOTION_MS.element
  await act(async () => {
    setSessionTransport("p2p");
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(appRoot().querySelector(".rd-touch-dock")).not.toBeNull();
  expect(appRoot().querySelector(".tab-bar.is-leaving")).not.toBeNull();

  await act(async () => {
    await new Promise((done) => setTimeout(done, MOTION_MS.element + 60));
  });
  expect(appRoot().querySelector(".tab-bar")).toBeNull();

  // Disconnect -> returns to disconnected preflight and restores visible 4-Tab Bar
  const disconnectBtn = appRoot().querySelector<HTMLButtonElement>(`button[aria-label="${t("desktop.disconnect")}"]`)!;
  await act(async () => {
    disconnectBtn.click();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(appRoot().querySelector(".rd-state-card")).not.toBeNull();
  const restoredBar = appRoot().querySelector(".tab-bar");
  expect(restoredBar).not.toBeNull();
  expect(restoredBar?.classList.contains("is-leaving")).toBeFalse();
});

test("desktop embeds in DeskShell main column with 3-item RailFoot, preserves paneId without PTY resize, and Settings/Computers match spec", async () => {
  const calls: string[] = [];
  act(() => {
    seedApp(calls);
    pointerState = { fine: true, coarse: false };
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    selectPane("w1:p1");
    setScreen("pane");
    mountApp();
  });
  expect(openPaneId()).toBe("w1:p1");

  // Mirrored 3-item RailFoot: Board | Desktop | Settings
  const railNav = [...appRoot().querySelectorAll<HTMLButtonElement>(".rail-nav .rail-nav-item")];
  expect(railNav).toHaveLength(3);
  expect(railNav.map((b) => b.textContent)).toEqual([t("tabs.board"), t("home.desktop"), t("tabs.settings")]);

  // Enter desktop via RailFoot -> embedded in DeskShell main column alongside Rail, no <dialog>, no PTY resize
  await act(async () => {
    openDesktop();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(currentScreen()).toBe("desktop");
  expect(appRoot().querySelector(".main.main-desktop .rd-surface")).not.toBeNull();
  expect(appRoot().querySelector(".rd-touch-dock")).toBeNull();
  expect(appRoot().querySelector("dialog.desktop-view")).toBeNull();
  expect(openPaneId()).toBe("w1:p1");
  expect(calls).not.toContain("terminalResize");

  // Leave desktop -> restores pane without PTY resize
  await act(async () => {
    leaveDesktop();
    await Promise.resolve();
  });
  expect(currentScreen()).toBe("pane");
  expect(openPaneId()).toBe("w1:p1");
  expect(calls).not.toContain("terminalResize");

  // Settings -> Computer shows DesktopSettingsSection; Computers page has no ConnectedDesktop or RecoveryConsole
  act(() => {
    setScreen("settings");
    setSettingsSection("connection");
    commitView();
  });
  expect(appRoot().querySelector(".rd-settings-group")).not.toBeNull();

  act(() => {
    setScreen("computers");
    commitView();
  });
  expect(appRoot().querySelector(".desktop-entry")).toBeNull();
  expect(appRoot().querySelector("details.recovery-console")).toBeNull();
});

test("hosts without view_desktop omit Desktop from phone TabBar (3 tabs) and desktop RailFoot (2 items)", () => {
  const calls: string[] = [];
  act(() => {
    seedApp(calls);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    setScreen("home");
    mountApp();
  });
  expect([...appRoot().querySelectorAll(".tab-bar .tab-bar-label")].map((n) => n.textContent))
    .toEqual([t("tabs.sessions"), t("tabs.board"), t("tabs.settings")]);

  act(() => {
    pointerState = { fine: true, coarse: false };
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    commitView();
  });
  expect([...appRoot().querySelectorAll(".rail-nav .rail-nav-item")].map((b) => b.textContent))
    .toEqual([t("tabs.board"), t("tabs.settings")]);
});

test("phone portrait view-only desktop hides the disabled touchpad so the video fills the screen", async () => {
  const calls: string[] = [];
  act(() => {
    seedApp(calls);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: true, control_desktop: false }, []);
    setScreen("desktop");
    mountApp();
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(appRoot().querySelector(".rd-touch-dock")).toBeNull();
  expect(appRoot().querySelector(".rd-floating-hud")).not.toBeNull();
});
