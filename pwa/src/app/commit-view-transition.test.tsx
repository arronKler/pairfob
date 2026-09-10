import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { appRoot } from "./dom-root";
import { commitView, appHost } from "./host";
import { frameStore, getAppFrame, registerSessionOwnerPreparer } from "./frame";
import { mountTestApp, unmountTestApp } from "../../test-support/react-harness";
import { isCommitting, lastCommittedLayoutKey, resetCommitState } from "./commit";
import { nextTransition, queuedKind, resetTransitionState } from "./transition";
import { goToScreen, navigationStore } from "./navigation-store";
import { runtimeStore } from "../features/connection/runtime-store";
import { publishPendingDomains } from "./domain-publication";
import { setLang } from "../lib/i18n";
import { batch } from "../shared/model/domain-store";
import { setPhase, setNetworkOnline } from "../features/connection/connection-store";
import { setScreen } from "./navigation-store";
import { setComputers, attachLiveSession, setCredential } from "../features/computers/catalog-store";
import { setAgentChat, setFullTerminal, selectPane, resetPaneView } from "../features/session/session-store";
import { applyRuntimeIdentity, resetRuntime } from "../features/connection/runtime-store";
import { resetDashboard } from "../features/dashboard/catalog-store";
import { resetBoardCatalog } from "../features/board/layout-store";
import { setOperationBusy } from "../features/operations/capabilities-store";
import { setTermFontPx } from "../features/settings/preferences-store";
import { setListGroup, setListGroupCollapsed } from "../features/settings/preferences-store";
import { clearNotice } from "./notices-store";

/**
 * Synchronous commitView with a declared view transition — captain contract.
 *
 * The public synchronous commit/navigation boundary must return with the
 * arriving DOM already rendered (frame/shell/DOM present), consume a declared
 * transition exactly once, and never start a native ViewTransition: native
 * capture defers its update callback, which a synchronous boundary does not
 * promise. The supported synchronous transition is the arrival-only CSS
 * fallback (`html[data-fallback-transition]`), reduced-motion aware, with its
 * own timer cleanup. Genuinely asynchronous, native-capable callers keep
 * `withTransition` and its real update callback (covered separately).
 */

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  registerSessionOwnerPreparer(null);
  resetTransitionState();
  resetCommitState();
  batch(() => {
    setPhase("live");
    setScreen("board");
    selectPane("");
    resetPaneView();
    setAgentChat(false);
    setFullTerminal(false);
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    attachLiveSession({ isConnected: () => true } as Parameters<typeof attachLiveSession>[0]);
    setCredential(null);
    setComputers([]);
    resetDashboard();
    resetBoardCatalog();
    setOperationBusy(false);
    setTermFontPx(12);
    clearNotice();
    setListGroup("flat");
    setListGroupCollapsed({});
  });
  publishPendingDomains();
  setLang("zh");
  mountTestApp();
});

afterEach(async () => {
  registerSessionOwnerPreparer(null);
  // Pair every mountTestApp with its full release: unmountTestApp unmounts the
  // App root AND clears the renderer callback setup registered, leaving no paint
  // frame published after teardown.
  await act(async () => { unmountTestApp(); });
  resetTransitionState();
  resetCommitState();
  resetRuntime();
});

type NativeStubOptions = {
  /** Install a real native startViewTransition stub (native-capable engine). */
  native: boolean;
};

function installNativeStub(options: NativeStubOptions): { starts: { value: number }; restore: () => void } {
  const starts = { value: 0 };
  const original = Object.getOwnPropertyDescriptor(document, "startViewTransition");
  if (options.native) {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: () => {
        starts.value += 1;
        throw new Error("native ViewTransition must never run on the synchronous path");
      },
    });
  } else {
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: undefined });
  }
  const restore = (): void => {
    if (original) Object.defineProperty(document, "startViewTransition", original);
    else delete (document as Document & { startViewTransition?: unknown }).startViewTransition;
  };
  return { starts, restore };
}

for (const native of [false, true]) {
  test(`commitView with a declared transition returns with the arriving DOM and the CSS fallback (native-capable=${native})`, async () => {
    const { starts, restore } = installNativeStub({ native });
    let atReturn: unknown;
    try {
      await act(async () => {
        nextTransition("fade");
        goToScreen("settings");
        commitView();
        atReturn = {
          settings: appRoot().querySelector(".settings-page") !== null,
          board: appRoot().querySelector(".board-shell") !== null,
          frame: getAppFrame().layout?.mode,
          queued: queuedKind(),
          native: starts.value,
        };
      });
      expect(atReturn).toEqual({
        settings: true, board: false, frame: "settings", queued: "none", native: 0,
      });
      // The supported synchronous transition is the arrival-only CSS fallback.
      expect(document.documentElement.dataset.fallbackTransition).toBe("fade");
      expect(isCommitting()).toBeFalse();
      expect(lastCommittedLayoutKey()).toBe(getAppFrame().layout?.key ?? "");
      expect(appHost() !== null).toBeTrue();
      // A following same-page commitView consumes nothing and never reaches native.
      await act(async () => { commitView(); await Promise.resolve(); });
      expect(starts.value).toBe(0);
      expect(queuedKind()).toBe("none");
      expect(appRoot().querySelector(".settings-page") !== null).toBeTrue();
      // App teardown clears the fallback class (its timer path is the same shared
      // engine the ordinary adapter uses, tested at the adapter level).
      resetTransitionState();
      expect(document.documentElement.dataset.fallbackTransition).toBeUndefined();
    } finally {
      resetTransitionState();
      restore();
    }
  });
}

test("commitView under reduced motion arrives with no fallback animation marker and no cleanup", async () => {
  const { starts, restore } = installNativeStub({ native: true });
  const realMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string): MediaQueryList => ({
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as typeof matchMedia);
  try {
    await act(async () => {
      nextTransition("fade");
      goToScreen("settings");
      commitView();
    });
    expect(appRoot().querySelector(".settings-page") !== null).toBeTrue();
    expect(appRoot().querySelector(".board-shell") === null).toBeTrue();
    expect(getAppFrame().layout?.mode).toBe("settings");
    expect(queuedKind()).toBe("none");
    expect(starts.value).toBe(0);
    // Reduced motion: the fallback entry paints without marking or scheduling.
    expect(document.documentElement.dataset.fallbackTransition).toBeUndefined();
  } finally {
    resetTransitionState();
    restore();
    globalThis.matchMedia = realMatchMedia;
  }
});

test("repeated synchronous navigations consume their declared transition each time and never strand a queue", async () => {
  const { starts, restore } = installNativeStub({ native: true });
  try {
    await act(async () => {
      nextTransition("fade");
      goToScreen("settings");
      commitView();
      nextTransition("fade");
      goToScreen("board");
      commitView();
    });
    expect(appRoot().querySelector(".board-shell") !== null).toBeTrue();
    expect(appRoot().querySelector(".settings-page") === null).toBeTrue();
    expect(getAppFrame().layout?.mode).toBe("board");
    expect(queuedKind()).toBe("none");
    expect(starts.value).toBe(0);
    expect(document.documentElement.dataset.fallbackTransition).toBe("fade");
    await act(async () => { commitView(); await Promise.resolve(); });
    expect(starts.value).toBe(0);
    expect(queuedKind()).toBe("none");
  } finally {
    resetTransitionState();
    restore();
  }
});

test("a nested synchronous navigation commits through the recommit path, consuming the declared transition once", async () => {
  const { starts, restore } = installNativeStub({ native: true });
  let nestedNavigated = false;
  let offlineApplied = false;
  let armed = false;
  try {
    // The offline runtime lands DURING the outer board commit: the outer commit
    // stays on board; when its frame publication fires mid-commit, apply the
    // offline identity. That runtime publication re-enters the commit and
    // navigates board->settings, consuming the declared transition exactly once
    // (the real recommit path, never two independent sequential commits).
    const releaseFrame = frameStore.subscribe(() => {
      if (!armed || offlineApplied) return;
      offlineApplied = true;
      applyRuntimeIdentity({ herdHost: "", runtimeKind: "offline" });
    });
    const release = runtimeStore.subscribe(() => {
      if (nestedNavigated || runtimeStore.get().runtimeKind !== "offline") return;
      nestedNavigated = true;
      nextTransition("fade");
      goToScreen("settings");
      commitView();
    });
    let outer: unknown;
    await act(async () => {
      nextTransition("fade");
      setScreen("board");
      armed = true;
      commitView();
      outer = {
        settings: appRoot().querySelector(".settings-page") !== null,
        board: appRoot().querySelector(".board-shell") !== null,
        queued: queuedKind(),
        native: starts.value,
      };
    });
    releaseFrame();
    release();
    expect(nestedNavigated).toBeTrue();
    // The offline identity was applied exactly once, during the outer flush.
    expect(offlineApplied).toBeTrue();
    expect(outer).toEqual({ settings: true, board: false, queued: "none", native: 0 });
    expect(starts.value).toBe(0);
    expect(document.documentElement.dataset.fallbackTransition).toBe("fade");
    expect(isCommitting()).toBeFalse();
    expect(navigationStore.get().screen).toBe("settings");
    expect(getAppFrame().layout?.mode).toBe("settings");
  } finally {
    resetTransitionState();
    restore();
  }
});