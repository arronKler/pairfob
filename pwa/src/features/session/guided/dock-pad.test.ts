import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact, mountTestApp, unmountTestApp, commitTest } from "../../../../test-support/react-harness";
import { DaemonPreferenceState } from "../../../../test-support/preferences-daemon-restore";
import { appRoot } from "../../../app/dom-root";
import { appHost } from "../../../app/host";

const { setLang } = await import("../../../lib/i18n");
const { clearNotice } = await import("../../../app/notices-store");
const { setPhase, setNetworkOnline } = await import("../../connection/connection-store.ts");
const { setScreen } = await import("../../../app/navigation-store.ts");
const { applyRuntimeIdentity, runtimeIdentity } = await import("../../connection/runtime-store");
const { resetPaneView, selectPane, setAgentChat, setFullTerminal } = await import("../session-store.ts");
const { setComposeLive } = await import("../compose-store.ts");
const { keysExpanded, padKind, setKeysExpanded, setPadKind } = await import("../../settings/preferences-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot } = await import("../../dashboard/catalog-store.ts");
const { composeIME, setComposeDraft, setComposeFocused, setComposeIME } = await import("../compose-store");
const { SLASH_COMMANDS } = await import("../../../lib/slash-commands.ts");
const { SessionDock, SessionKeyPad } = await import("./session-dock.tsx");
import type { LiveSession } from "../../../lib/protocol/client";

function paintDock(): void {
  renderReact(createElement(SessionDock, { includeBack: true }));
}

function kindOption(label: "按键" | "命令"): HTMLButtonElement {
  return [...appRoot().querySelectorAll<HTMLButtonElement>(".pad-kind-option")].find((el) => el.textContent === label)!;
}

function paintPad(): void {
  renderReact(createElement(SessionKeyPad));
}

/** Guided session mock the mounted App drives; keeps the compose field bound. */
function sessionMock(): LiveSession {
  return {
    isConnected: () => true,
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    paneRead: async () => ({ text: "hello\nworld", hash: "1".repeat(64) }),
    snapshot: async () => ({}),
    getConfig: async () => ({}),
    ping: async () => undefined,
    listDevices: async () => ({}),
    onEvent: () => () => undefined,
    close: () => undefined,
  } as unknown as LiveSession;
}

/** Guard the daemon-scoped preference maps/raws the App snapshot seeding touches. */
const daemonPreferenceState = new DaemonPreferenceState();

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
  setLang("zh");
  clearNotice();
  daemonPreferenceState.capture();
});

afterEach(async () => {
  unmountReact();
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeIME(false);
  setComposeFocused(false);
  setComposeDraft("");
  clearNotice();
  appRoot().replaceChildren();
});

describe("session pad morphs", () => {
  test("expanding and switching pad modes preserves the same focused IME field and selection", async () => {
    setKeysExpanded(false);
    setPadKind("keys");
    // The no-global-commit contract runs under the actual mounted App/host: the
    // guided SessionDock + compose field are produced by the production App and
    // the real host.commit/requestCommit are counted by forwarding their methods.
    // A pad morph must be a local React + preference update, never a global commit.
    mountTestApp();
    act(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      resetPaneView();
      setFullTerminal(false);
      setAgentChat(false);
      setComposeLive(false);
      setNetworkOnline(true);
      applyRuntimeIdentity({ herdHost: runtimeIdentity().herdHost, runtimeKind: "herdr" });
      attachLiveSession(sessionMock());
      applySnapshot({
        workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", agent: "herdr", agent_status: "working" }],
      });
    });
    commitTest();
    const host = appHost()!;
    const originalCommit = host.commit;
    const originalRequest = host.requestCommit;
    let commits = 0;
    let requests = 0;
    host.commit = function (this: unknown, ...args: unknown[]) {
      commits += 1;
      return (originalCommit as unknown as (...a: unknown[]) => unknown).apply(this, args);
    };
    host.requestCommit = function (this: unknown, ...args: unknown[]) {
      requests += 1;
      return (originalRequest as unknown as (...a: unknown[]) => unknown).apply(this, args);
    };
    try {
      const input = appRoot().querySelector("textarea")!;
      const view = appRoot().ownerDocument.defaultView!;
      input.value = "正在编辑的文字";
      act(() => { input.focus(); });
      input.setSelectionRange(1, 4);
      act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
      const tap = async (button: HTMLButtonElement) => {
        const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
        act(() => { button.dispatchEvent(down); });
        expect(down.defaultPrevented).toBe(true);
        await act(() => { button.click(); });
        expectSameNode(appRoot().querySelector("textarea"), input);
        expectSameNode(document.activeElement, input);
        expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
        expect(input.value).toBe("正在编辑的文字");
        expect(composeIME()).toBe(true);
      };
      await tap(appRoot().querySelector(".key-more")!);
      expect(keysExpanded()).toBe(true);
      await tap(kindOption("命令"));
      expect(appRoot().querySelector(".slash-pad")).toBeTruthy();
      await tap(kindOption("按键"));
      expect(appRoot().querySelector(".key-mod")).toBeTruthy();
      await tap(appRoot().querySelector(".key-more")!);
      expect(keysExpanded()).toBe(false);
      expect(commits).toBe(0);
      expect(requests).toBe(0);
      expect(appHost() === host).toBeTrue();
    } finally {
      host.commit = originalCommit;
      host.requestCommit = originalRequest;
      // Keep the App/host alive through every assertion above, then retire the
      // live/route identities this fixture installed and give the daemon-scoped
      // preference maps/raw keys the snapshot seeding pruned back to their
      // pre-case values (raw and canonical handled separately).
      daemonPreferenceState.restore();
      attachLiveSession(null);
      selectPane("");
      setScreen("home");
      unmountTestApp();
    }
  });

  test("collapsed pad keeps only the TUI survival row", async () => {
    setKeysExpanded(false);
    await act(() => { paintPad(); });
    expect(appRoot().querySelector(".pad-kind")).toBeNull();
    expect(appRoot().querySelector(".slash-pad")).toBeNull();
    expect(appRoot().querySelector('[aria-label="终端快捷键"]')).toBeTruthy();
    expect(appRoot().querySelectorAll('[aria-label="终端快捷键"] > .key')).toHaveLength(7);
  });

  test("expanded keys still expose Tab, Enter and modifiers", async () => {
    setKeysExpanded(true);
    setPadKind("keys");
    await act(() => { paintPad(); });
    expect(kindOption("按键").getAttribute("aria-pressed")).toBe("true");
    expect(kindOption("命令").getAttribute("aria-pressed")).toBe("false");
    expect(appRoot().querySelector(".slash-pad")).toBeNull();
    expect(appRoot().textContent).toContain("Tab");
    expect(appRoot().textContent).toContain("Ctrl");
    expect(appRoot().textContent).not.toContain("换行");
    expect(appRoot().querySelector('[aria-label="Alt / Option"]')?.textContent).toBe("Alt");
    // A chord reads as one full name even though it is drawn on two lines.
    expect(appRoot().querySelector('[aria-label="Ctrl+C"] small')?.textContent).toBe("Ctrl");
    expect(appRoot().querySelector(".pad-pagination-start .pad-page-name")?.textContent).toBe("控制");
    expect(appRoot().querySelector(".pad-pagination-end .pad-kind")).not.toBeNull();
  });

  test("expanded command morph fills compose chips and not SendKeys", async () => {
    applySnapshot({ panes: [{ pane_id: "shortcut-test", agent: "claude" }] });
    selectPane("shortcut-test");
    setKeysExpanded(true);
    setPadKind("slash");
    await act(() => { paintPad(); });
    const chips = [...appRoot().querySelectorAll(".slash-cmd")].map((el) => el.textContent);
    expect(chips).toEqual(SLASH_COMMANDS.map((command) => command.label));
    expect(appRoot().textContent).not.toContain("Tab");
    expect(kindOption("命令").getAttribute("aria-pressed")).toBe("true");
    expect(appRoot().querySelector(".pad-pagination-start")?.textContent).toBe("编辑");
  });
});
test("while the soft keyboard is up only the primary row renders; ⋯ puts the keyboard away first", async () => {
  setKeysExpanded(true);
  setPadKind("keys");
  const field = document.createElement("textarea");
  appRoot().after(field);
  const root = document.documentElement;
  try {
    await act(() => { paintPad(); });
    expect(appRoot().querySelector(".pad-pages")).toBeTruthy();
    await act(async () => { field.focus(); root.dataset.kb = "open"; await Promise.resolve(); });
    expect(appRoot().querySelector(".pad-pages")).toBeNull();
    expect(appRoot().querySelectorAll('[aria-label="终端快捷键"] > .key')).toHaveLength(7);
    expect(keysExpanded()).toBe(true);
    await act(() => { appRoot().querySelector<HTMLButtonElement>(".key-more")!.click(); });
    expectDifferentNode(document.activeElement, field);
    expect(keysExpanded()).toBe(true);
    await act(async () => { root.dataset.kb = "closed"; await Promise.resolve(); });
    expect(appRoot().querySelector(".pad-pages")).toBeTruthy();
  } finally {
    delete root.dataset.kb;
    field.remove();
  }
});
