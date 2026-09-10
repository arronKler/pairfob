import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, Profiler, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetBoardTestDOM } from "../../test-support/dom";
import type { PairResult } from "../lib/protocol/client";
import type { AppHost } from "./host";

const { App } = await import("./App");
const { commitApp, lastCommittedLayoutKey, requestCommit, resetCommitState } = await import("./commit");
const { registerAppHost, releaseAppHost } = await import("./host");
const { appRoot } = await import("./dom-root");
const { frameStore, getAppFrame, subscribeAppFrame } = await import("./frame");
const { isAppMounted, mountApp, unmountApp } = await import("./mount");
const { clearShell } = await import("./shell");
const { setPhase } = await import("../features/connection/connection-store");
const { setScreen, goToScreen, navigationStore } = await import("./navigation-store");
const { publishAllDomains } = await import("./domain-publication");
const { setCredential, attachLiveSession, setComputers, setAddingComputer } = await import("../features/computers/catalog-store");
const { setOperationBusy } = await import("../features/operations/capabilities-store");
const { setTermFontPx } = await import("../features/settings/preferences-store");
const { resetDashboard } = await import("../features/dashboard/catalog-store");
const { resetPaneView, setAgentChat, setFullTerminal } = await import("../features/session/session-store");
const { clearNotice } = await import("./notices-store");
const { applyRuntimeIdentity } = await import("../features/connection/runtime-store");

function computer(hostname: string): PairResult {
  return {
    daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "dev_phone", psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32), relayOrigin: "https://pairfob.com", fp: "fp", label: "Phone",
    createdAt: 1, hostname,
  };
}

let root: Root | null = null;
let container: HTMLElement;
let phases: string[] = [];

/** Reset every domain the suite writes to the boot baseline (typed actions). */
function resetDomains(): void {
  setPhase("boot");
  setScreen("home");
  setCredential(null);
  setComputers([]);
  setAddingComputer(false);
  setOperationBusy(false);
  setTermFontPx(12);
  resetDashboard();
  resetPaneView();
  attachLiveSession(null);
  setAgentChat(false);
  setFullTerminal(false);
  clearNotice();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  phases = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetDomains();
  publishAllDomains();
  resetCommitState();
});

afterEach(() => {
  if (isAppMounted()) act(() => { unmountApp(); });
  act(() => { root?.unmount(); });
  root = null;
  container.remove();
  clearShell();
  resetCommitState();
  resetDomains();
  publishAllDomains();
});

const screenSnapshot = () => navigationStore.get().screen;

/** Reads the screen domain and the composition in the same render, like a page. */
function NavigationProbe({ seen }: { seen: Array<{ screen: string; mode: string }> }) {
  const screen = useSyncExternalStore(navigationStore.subscribe, screenSnapshot);
  const frame = useSyncExternalStore(subscribeAppFrame, getAppFrame);
  seen.push({ screen, mode: frame.layout?.mode ?? "none" });
  return null;
}

/** Presence checks stay boolean so a failure cannot dump a whole element. */
function shown(selector: string): boolean {
  return Boolean(container.querySelector(selector));
}

function mounted(selector: string): boolean {
  return Boolean(appRoot().querySelector(selector));
}

/** Mount `<App/>` under a Profiler so every render pass of the tree is counted. */
function mountProfiled(): void {
  act(() => {
    root?.render(createElement(Profiler, {
      id: "app",
      onRender: (_id: string, phase: string) => { phases.push(phase); },
    }, createElement(App)));
    commitApp({ sync: true });
  });
}

function mounts(): number {
  return phases.filter((phase) => phase === "mount").length;
}

function updates(): number {
  return phases.filter((phase) => phase !== "mount").length;
}

describe("a stable mounted App composes pages declaratively", () => {
  test("navigation swaps pages without mounting another root", () => {
    mountProfiled();
    expect(mounts()).toBe(1);
    expect(shown(".boot")).toBeTrue();

    act(() => { setPhase("connect"); commitApp(); });
    expect(shown(".boot")).toBeFalse();
    expect(shown(".prelude")).toBeTrue();

    act(() => { setPhase("pick"); commitApp(); });
    expect(shown(".prelude")).toBeFalse();
    expect(shown(".computer-list")).toBeTrue();

    act(() => { setPhase("boot"); commitApp(); });
    expect(shown(".boot")).toBeTrue();
    // Four compositions, one mount: nothing re-created the root or the tree.
    expect(mounts()).toBe(1);
    expect(lastCommittedLayoutKey().startsWith("boot:")).toBeTrue();
  });

  test("one commit publishes one frame and renders the tree once", () => {
    mountProfiled();
    let frames = 0;
    const release = frameStore.subscribe(() => { frames += 1; });
    phases = [];

    act(() => {
      // Three domains written through named typed actions, then a single commit.
      setOperationBusy(true);
      setTermFontPx(15);
      applyRuntimeIdentity({ herdHost: "Studio", runtimeKind: "herdr" });
      commitApp();
    });

    expect(frames).toBe(1);
    expect(updates()).toBe(1);
    expect(appRoot().getAttribute("aria-busy")).toBe("true");
    expect(appRoot().style.getPropertyValue("--term-fs")).toBe("15px");
    release();
  });

  test("an ordinary update is scheduled, a composition change commits at once", () => {
    setPhase("resuming");
    setCredential(null);
    mountProfiled();
    expect(container.textContent?.includes("Studio")).toBeFalse();

    // Same page, new copy: React may schedule this.
    act(() => {
      setCredential(computer("Studio"));
      commitApp();
      expect(container.textContent?.includes("Studio")).toBeFalse();
    });
    expect(container.textContent?.includes("Studio")).toBeTrue();

    // A different page has to be on screen when the commit returns, because the
    // caller measures, scrolls or focuses the arriving page right away.
    act(() => {
      setPhase("connect");
      commitApp();
      expect(shown(".prelude")).toBeTrue();
    });
  });

  test("a typed navigation action recomposes without a caller painting", async () => {
    act(() => { mountApp(); });
    expect(isAppMounted()).toBeTrue();
    expect(mounted(".boot")).toBeTrue();

    // setPhase asks the mounted app for a coalesced commit; nobody paints here.
    await act(async () => { setPhase("connect"); });
    expect(mounted(".prelude")).toBeTrue();

    // A screen action alone is not enough while pairing owns the page: the phase
    // decides, and the action for it recomposes on its own.
    await act(async () => { goToScreen("home"); });
    expect(mounted(".prelude")).toBeTrue();
    await act(async () => { setPhase("live"); });
    expect(mounted(".prelude")).toBeFalse();
    expect(mounted(".herd, .card-list, .empty")).toBeTrue();
  });

  test("a React render never sees a newer screen than the composition", async () => {
    setPhase("live");
    setScreen("home");
    // The harness root is not the mounted app, so register the host the mounted
    // app would: a staged composition change then publishes with its commit.
    const host: AppHost = {
      commit: (options) => commitApp(options),
      requestCommit: () => requestCommit(),
      unmount: () => undefined,
    };
    registerAppHost(host);
    const seen: Array<{ screen: string; mode: string }> = [];
    act(() => {
      root?.render(createElement(Profiler, {
        id: "app",
        onRender: (_id: string, phase: string) => { phases.push(phase); },
      }, createElement(App), createElement(NavigationProbe, { seen })));
      commitApp({ sync: true });
    });

    // A typed navigation publishes its domain and asks for the commit first, so the
    // queued commit runs before React's flush: no render observes a screen the
    // composition has not caught up with.
    await act(async () => { goToScreen("settings"); });
    await act(async () => { goToScreen("home"); });

    releaseAppHost(host);
    expect(seen.length).toBeGreaterThan(1);
    // Every render sees the screen and the composition that belongs to it.
    expect(seen.filter((entry) => entry.screen !== entry.mode)).toEqual([]);
    expect(seen[seen.length - 1]).toEqual({ screen: "home", mode: "home" });
  });

  test("a paint requested by an action and by its caller is still one commit", async () => {
    act(() => { mountApp(); });
    let frames = 0;
    const release = frameStore.subscribe(() => { frames += 1; });
    await act(async () => {
      setPhase("connect");
      // The legacy caller paints as well; the scheduled commit must be cancelled.
      commitApp({ sync: true });
      expect(frames).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(frames).toBe(1);
    });
    expect(frames).toBe(1);
    release();
  });
});

describe("mount and unmount cleanup", () => {
  test("unmounting clears the shell and stops rendering", () => {
    act(() => { mountApp(); });
    expect(appRoot().classList.contains("boot-screen")).toBeTrue();
    expect(document.body.classList.contains("lock")).toBeTrue();

    act(() => { unmountApp(); });
    expect(isAppMounted()).toBeFalse();
    expect(appRoot().classList.contains("boot-screen")).toBeFalse();
    expect(appRoot().getAttribute("aria-busy")).toBeNull();
    expect(document.body.classList.contains("lock")).toBeFalse();

    // A commit with nothing mounted publishes but renders nothing.
    let frames = 0;
    const release = frameStore.subscribe(() => { frames += 1; });
    act(() => { setPhase("connect"); commitApp(); });
    expect(frames).toBe(1);
    expect(mounted(".prelude")).toBeFalse();
    release();
  });

  test("remounting after teardown composes the current page once", () => {
    act(() => { mountApp(); });
    act(() => { unmountApp(); });
    setPhase("pick");
    act(() => { mountApp(); });
    expect(mounted(".computer-list")).toBeTrue();
    expect(appRoot().classList.contains("boot-screen")).toBeFalse();
    act(() => { unmountApp(); });
  });
});
