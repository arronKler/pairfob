import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act, createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, test } from "bun:test";
import type { LiveSession, PairResult, SessionEvent } from "../../lib/protocol/client";
import { FullTerminalScreen } from "../session/full-terminal/full-terminal-screen";
import { syncFullTerminalChrome } from "../session/full-terminal/full-terminal";
import { appRoot } from "../../app/dom-root";
import { t } from "../../lib/i18n";
import { attachLiveSession, setCredential } from "../computers/catalog-store";
import { setNetworkOnline } from "./connection-store";
import { applySnapshot, dashboardStore } from "../dashboard/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { applyPaneRead, selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { applyRuntimeIdentity, resetRuntime } from "./runtime-store";
import { resetGenerationsForTests } from "./generations";
import { closeComputerSession, establish, recoverVisibleSession, startPolling, stopPolling } from "./controller";

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

type Boot = { reads: () => number; change: (next: string, paneId?: string) => void; session: LiveSession };

async function boot(fullTerminal: boolean): Promise<Boot> {
  globalThis.fetch = (async () => new Response("1.0.0")) as typeof fetch;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  // A real LiveSession fans events out to every subscriber (the session pool and,
  // with the pad mounted, the attachment tray's connection watch).
  const listeners = new Set<(event: SessionEvent) => void>();
  let status = "working";
  let reads = 0;
  const session = {
    close: () => undefined,
    isConnected: () => true,
    setNetworkAvailable: () => undefined,
    switchTransport: async () => undefined,
    onEvent: (fn: (event: SessionEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
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
    session,
    change: (next: string, paneId = "p1") => {
      status = next;
      for (const listener of [...listeners]) listener({ type: "poke", reason: "agent_status", paneId });
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

test("slow foreground recovery gates polling and coalesces repeated triggers", async () => {
  const runtime = await boot(false);
  setAgentChat(true);
  let releaseConfig!: () => void;
  let configReads = 0;
  let traceReads = 0;
  const order: string[] = [];
  runtime.session.getConfig = async () => {
    configReads += 1;
    order.push(`config:${configReads}:start`);
    if (configReads === 1) await new Promise<void>((resolve) => { releaseConfig = resolve; });
    order.push(`config:${configReads}:done`);
    return { build: "1.0.0" };
  };
  runtime.session.snapshot = async () => {
    order.push("snapshot");
    return { panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working" }] };
  };
  runtime.session.agentTrace = async () => {
    traceReads += 1;
    order.push("tail");
    return { items: [], nextCursor: null, truncated: false };
  };

  startPolling();
  const recovery = recoverVisibleSession();
  const repeated = [recoverVisibleSession(), recoverVisibleSession()];
  await new Promise<void>((resolve) => setTimeout(resolve, 1_650));
  expect({ traceReads, configReads }).toEqual({ traceReads: 0, configReads: 1 });
  releaseConfig();
  await Promise.all([recovery, ...repeated]);
  expect(configReads).toBe(2);
  expect(traceReads).toBe(2);
  expect(order).toEqual([
    "config:1:start", "config:1:done", "snapshot", "tail",
    "config:2:start", "config:2:done", "snapshot", "tail",
  ]);
});

test("hiding during a pending foreground config cannot start a tail read", async () => {
  const runtime = await boot(false);
  setAgentChat(true);
  let releaseConfig!: () => void;
  let traceReads = 0;
  runtime.session.getConfig = async () => {
    await new Promise<void>((resolve) => { releaseConfig = resolve; });
    return { build: "1.0.0" };
  };
  runtime.session.agentTrace = async () => {
    traceReads += 1;
    return { items: [], nextCursor: null, truncated: false };
  };

  startPolling();
  const recovery = recoverVisibleSession();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  stopPolling();
  releaseConfig();
  await recovery;
  expect(traceReads).toBe(0);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

test("hiding during a pending foreground snapshot cannot start a tail read", async () => {
  const runtime = await boot(false);
  setAgentChat(true);
  let releaseSnapshot!: () => void;
  let snapshotStarted = false;
  let traceReads = 0;
  runtime.session.getConfig = async () => ({ build: "1.0.0" });
  runtime.session.snapshot = async () => {
    snapshotStarted = true;
    await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    return { panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working" }] };
  };
  runtime.session.agentTrace = async () => {
    traceReads += 1;
    return { items: [], nextCursor: null, truncated: false };
  };

  startPolling();
  const recovery = recoverVisibleSession();
  for (let index = 0; index < 10 && !snapshotStarted; index += 1) await Promise.resolve();
  expect(snapshotStarted).toBeTrue();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  stopPolling();
  releaseSnapshot();
  await recovery;
  expect(traceReads).toBe(0);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

test("mobile full-terminal controls follow status without remounting the terminal", async () => {
  const runtime = await boot(true);
  applyRuntimeIdentity({ herdHost: "m1", runtimeKind: "herdr" });
  setNetworkOnline(true);
  const noop = () => {};
  act(() => {
    syncFullTerminalChrome();
    renderScreen(createElement(FullTerminalScreen, {
      onBack: noop, onWorkspace: noop, onMenu: noop, onRetry: noop,
      scroll: noop, pageLines: () => 23, engineActive: false,
      controls: { sendKey: noop, sendCompose: () => true, desk: false,
        keyboard: { toggle: noop, open: noop, close: noop, isOpen: () => false } },
    }));
  });
  const host = app().querySelector(".full-terminal-host");
  expect(host === null).toBeFalse();
  expect(app().querySelector("[data-react-full-terminal]") === null).toBeFalse();
  await act(async () => { runtime.change("working"); await settle(); });
  expect(app().querySelector(".full-terminal-chrome .chrome-status")?.textContent).toBe(t("status.working"));
  await act(async () => { runtime.change("done"); await settle(); });
  expect(app().querySelector(".full-terminal-chrome .chrome-status")?.textContent).toBe(t("status.done"));
  expect(app().querySelector(".icon-stop") === null).toBeTrue();
  expect(app().querySelector(".full-terminal-host")).toBe(host);
});