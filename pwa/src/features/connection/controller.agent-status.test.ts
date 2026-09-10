import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act, createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test } from "bun:test";
import type { LiveSession, PairResult, SessionEvent } from "../../lib/protocol/client";
import { FullTerminalScreen } from "../session/full-terminal/full-terminal-screen";
import { syncFullTerminalChrome } from "../session/full-terminal/full-terminal";
import { appRoot } from "../../app/dom-root";
import { attachLiveSession, setCredential } from "../computers/catalog-store";
import { setNetworkOnline } from "./connection-store";
import { applySnapshot, dashboardStore } from "../dashboard/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { applyPaneRead, selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { applyRuntimeIdentity, resetRuntime } from "./runtime-store";
import { resetGenerationsForTests } from "./generations";
import { closeComputerSession, establish, stopPolling } from "./controller";

function app(): HTMLElement {
  return document.getElementById("app") as HTMLElement;
}

/**
 * Scoped standalone React root for this renderer/chrome unit contract: the
 * real FullTerminalScreen component mounted from its feature path, with no App
 * and no global legacy renderer. The root is disposed explicitly before the
 * DOM reset in afterEach so no React tree outlives its container.
 */
let screenRoot: Root | undefined;

function renderScreen(screen: ReactNode): void {
  screenRoot ??= createRoot(appRoot());
  flushSync(() => {
    screenRoot?.render(screen);
  });
}

function leaveScreen(): void {
  const root = screenRoot;
  screenRoot = undefined;
  if (root) flushSync(() => { root.unmount(); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  resetGenerationsForTests();
  // Named network baseline: an earlier offline bootstrap in a combined run must
  // not leave `networkOnline` false, or the production snapshot gate would skip
  // the status read this suite expects (full=false before+1 would stay 0).
  setNetworkOnline(true);
});

const originalFetch = globalThis.fetch;
const daemonId = "agent_status_events";

afterEach(async () => act(async () => {
  leaveScreen();
  stopPolling();
  closeComputerSession(daemonId);
  attachLiveSession(null);
  setCredential(null);
  setFullTerminal(false);
  setAgentChat(false);
  resetRuntime();
  setNetworkOnline(true);
  applySnapshot({ panes: [] });
  globalThis.fetch = originalFetch;
  app().replaceChildren();
}));

type Boot = { reads: () => number; change: (next: string, paneId?: string) => void };

async function boot(fullTerminal: boolean): Promise<Boot> {
  globalThis.fetch = (async () => new Response("1.0.0")) as typeof fetch;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  let listener!: (event: SessionEvent) => void;
  let status = "working";
  let reads = 0;
  const session = {
    close: () => undefined,
    isConnected: () => true,
    setNetworkAvailable: () => undefined,
    switchTransport: async () => undefined,
    onEvent: (fn: typeof listener) => { listener = fn; return () => {}; },
    getConfig: async () => ({ build: "1.0.0" }),
    snapshot: async () => {
      reads += 1;
      return {
        panes: ["p1", "p2"].map((pane_id) => ({ pane_id, workspace_id: "w1", agent: "codex", agent_status: status })),
      };
    },
    paneRead: async () => ({ text: "unchanged terminal", hash: "a".repeat(64) }),
  } as unknown as LiveSession;
  await establish(
    { daemonId, deviceId: "phone", psk: new Uint8Array(32), daemonPk: new Uint8Array(32), relayOrigin: "https://pairfob.com", fp: "test", createdAt: 1 } as PairResult,
    async () => session,
  );
  stopPolling();
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(fullTerminal);
  setAgentChat(false);
  applyPaneRead("unchanged terminal", "a".repeat(64));
  return {
    reads: () => reads,
    change: (next: string, paneId = "p1") => {
      status = next;
      listener({ type: "poke", reason: "agent_status", paneId });
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

for (const full of [false, true]) {
  test(`status events reach the production snapshot path without fallback timers (full=${full})`, async () => {
    const runtime = await boot(full);
    const before = runtime.reads();
    runtime.change("done");
    await settle();
    expect(runtime.reads()).toBe(before + 1);
    expect(dashboardStore.get().runtimeAgentStatuses.p1).toBe("done");
    runtime.change("working");
    await settle();
    expect(dashboardStore.get().runtimeAgentStatuses.p1).toBe("working");
    expect(dashboardStore.get().agents.find((a) => a.paneId === "p1")?.status).toBe("working");
  });
}

test("another pane's status updates the sidebar while a terminal is open", async () => {
  const runtime = await boot(true);
  const before = runtime.reads();
  runtime.change("done", "p2");
  await settle();
  expect(runtime.reads()).toBe(before + 1);
  expect(dashboardStore.get().agents.find((a) => a.paneId === "p2")?.status).toBe("done");
});

test("hidden status events do not start network reads", async () => {
  const runtime = await boot(true);
  const before = runtime.reads();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  runtime.change("done");
  await settle();
  expect(runtime.reads()).toBe(before);
});

test("mobile full-terminal controls follow status without remounting the terminal", async () => {
  const runtime = await boot(true);
  applyRuntimeIdentity({ herdHost: "m1", runtimeKind: "herdr" });
  setNetworkOnline(true);
  const noop = () => {};
  act(() => {
    syncFullTerminalChrome();
    renderScreen(createElement(FullTerminalScreen, {
      onBack: noop, onWorkspace: noop, onMenu: noop, onStop: noop, onRetry: noop,
      scroll: noop, pageLines: () => 23, engineActive: false,
      controls: { sendKey: noop, sendCompose: () => true, desk: false,
        keyboard: { toggle: noop, open: noop, close: noop, isOpen: () => false } },
    }));
  });
  const host = app().querySelector(".full-terminal-host");
  expect(host === null).toBeFalse();
  expect(app().querySelector("[data-react-full-terminal]") === null).toBeFalse();
  await act(async () => { runtime.change("working"); await settle(); });
  expect(app().querySelector(".icon-stop") === null).toBeFalse();
  await act(async () => { runtime.change("done"); await settle(); });
  expect(app().querySelector(".icon-stop") === null).toBeTrue();
  expect(app().querySelector(".full-terminal-host")).toBe(host);
});