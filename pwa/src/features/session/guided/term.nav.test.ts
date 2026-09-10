import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { LiveSession } from "../../../lib/protocol/client";

const { appRoot } = await import("../../../app/dom-root.ts");
const app = appRoot();
const { batch } = await import("../../../shared/model/domain-store.ts");
const { appHost, commitView } = await import("../../../app/host.ts");
const { isAppMounted, mountApp, unmountApp } = await import("../../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../../app/frame.ts");
const { registerSessionView } = await import("../../../features/session/register.ts");
const { resetTransitionState } = await import("../../../app/transition.ts");
const { setPhase } = await import("../../connection/connection-store.ts");
const { setScreen } = await import("../../../app/navigation-store.ts");
const { applyPaneRead, resetPaneView, selectPane, setAgentChat, setFullTerminal } =
  await import("../session-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot } = await import("../../dashboard/catalog-store.ts");
const { applyCapabilities, clearCapabilities } = await import("../../operations/capabilities-store.ts");
const { applyRuntimeIdentity, runtimeIdentity } = await import("../../connection/runtime-store");
const { setTermFontPx, termFontPx } = await import("../../settings/preferences-store.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../../../lib/operations.ts");
const { resetComposeDrafts } = await import("../drafts/compose-drafts.ts");
const { guidedScrollController } = await import("./guided-scroll.ts");

const DEMO_WORKSPACES = [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }] as const;

function publishGuidedPane(status = "idle"): void {
  applySnapshot({
    focused: { pane_id: "p1" },
    workspaces: DEMO_WORKSPACES,
    panes: [{ pane_id: "p1", workspace_id: "w1", agent: "herdr", agent_status: status }],
  });
}

function live(): LiveSession {
  return {
    history: async () => ({ items: [{ role: "assistant", text: "old\nline" }], next_cursor: null, truncated: false }),
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  } as unknown as LiveSession;
}

// The actual stable App owns composition: an actual stable App is mounted with
// the production session-owner preparer, typed domain actions publish through
// the installed host's synchronous commitView port. No paint host, no facade
// writes, no manual flush.
function bootGuided(): void {
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      resetPaneView();
      applyPaneRead("ready", "h-ready");
      setFullTerminal(false);
      setAgentChat(false);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, history: true }, []);
      applyRuntimeIdentity({ herdHost: runtimeIdentity().herdHost, runtimeKind: "herdr" });
      publishGuidedPane();
      attachLiveSession(live());
    });
    mountApp();
    commitView();
  });
}

function click(label: string): void {
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}: ${app.innerHTML.slice(0, 280)}`);
  act(() => el.click());
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTransitionState();
  resetComposeDrafts();
  registerSessionOwnerPreparer(registerSessionView);
});

afterEach(async () => {
  guidedScrollController.dispose();
  closeTestDialogs();
  await act(async () => {
    unmountApp();
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    clearCapabilities();
    resetTransitionState();
    resetComposeDrafts();
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

describe("guided pane no longer overlays earlier output", () => {
  test("a zoomed Control buffer leaves pinch to the browser and preserves its font", () => {
    const viewport = { scale: 2 };
    bootGuided();
    const font = termFontPx();
    const term = app.querySelector<HTMLElement>(".term")!;
    const pageWindow = term.ownerDocument.defaultView!;
    const previousViewport = Object.getOwnPropertyDescriptor(pageWindow, "visualViewport");
    Object.defineProperty(pageWindow, "visualViewport", { configurable: true, value: viewport });
    const touch = (type: string, distance: number) => {
      const event = new happy.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }] });
      act(() => { term.dispatchEvent(event as unknown as Event); });
      return event;
    };
    try {
      touch("touchstart", 100);
      expect(touch("touchmove", 80).defaultPrevented).toBeFalse();
      viewport.scale = 1;
      expect(touch("touchmove", 50).defaultPrevented).toBeFalse();
      expect(termFontPx()).toBe(font);
      touch("touchend", 0);
      touch("touchstart", 100);
      expect(touch("touchmove", 140).defaultPrevented).toBeTrue();
      expect(termFontPx()).toBeGreaterThan(font);
    } finally {
      if (previousViewport) Object.defineProperty(pageWindow, "visualViewport", previousViewport);
      else Reflect.deleteProperty(pageWindow, "visualViewport");
      act(() => setTermFontPx(font));
    }
  });

  test("the live buffer has no 更早的输出 chip", () => {
    bootGuided();
    expect(app.querySelector(".term-more")).toBeNull();
    expect(app.querySelector(".term-back")).toBeNull();
    expect(app.querySelector(".term")).toBeTruthy();
    expect(app.querySelector(".full-terminal-scroll")).toBeTruthy();
    expect([...app.querySelectorAll(".full-terminal-scroll-btn")].map((el) => el.getAttribute("aria-label"))).toEqual([
      "鼠标滚轮向上",
      "上一页",
      "下一页",
      "鼠标滚轮向下",
    ]);
  });

  test("会话操作 has no 更早的输出 even when history is allowed", () => {
    bootGuided();
    click("会话操作");
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.textContent).not.toContain("更早的输出");
    expect(document.querySelector("dialog.history-modal")).toBeNull();
    expect(app.querySelector(".term-more")).toBeNull();
  });
});

describe("interrupt while unverifiable", () => {
  test("a working pane hides Stop after a disconnect or failed GetConfig", () => {
    bootGuided();
    act(() => { publishGuidedPane("working"); commitView(); });
    expect(app.querySelector(".icon-stop")).not.toBeNull();

    act(() => { attachLiveSession({ ...live(), isConnected: () => false } as LiveSession); commitView(); });
    expect(app.querySelector(".icon-stop")).toBeNull();
    expect(app.querySelector(".chrome-meta-text")?.textContent).toContain("未知");

    act(() => {
      attachLiveSession(live());
      applyRuntimeIdentity({ herdHost: runtimeIdentity().herdHost, runtimeKind: "" });
      commitView();
    });
    expect(app.querySelector(".icon-stop")).toBeNull();
  });
});

describe("control-mode TUI page rail", () => {
  test("outer arrows send mouse-wheel TerminalScroll instead of cursor keys", async () => {
    bootGuided();
    const scrolls: Array<Record<string, unknown>> = [];
    const keys: string[][] = [];
    const session = live();
    act(() => {
      attachLiveSession({
        ...session,
        sendKeys: async (_paneId, batch) => {
          keys.push(batch);
        },
        terminalOpen: async (paneId, cols, rows) => ({
          operationId: "op_open",
          terminalId: "term_00000000000000000000000000000000",
          paneId,
          cols,
          rows,
          encoding: "ansi" as const,
        }),
        terminalScroll: async (terminalId, sequence, direction, lines, source) => {
          scrolls.push({ terminalId, sequence, direction, lines, source });
        },
        terminalClose: async () => undefined,
      } as LiveSession);
      commitView();
    });
    const rail = [...app.querySelectorAll(".full-terminal-scroll-btn")] as HTMLButtonElement[];
    const wheelUp = rail.find((el) => el.getAttribute("aria-label") === "鼠标滚轮向上");
    const wheelDown = rail.find((el) => el.getAttribute("aria-label") === "鼠标滚轮向下");
    if (!wheelUp || !wheelDown) throw new Error("missing wheel buttons");
    const tap = () =>
      new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true, cancelable: true });
    await act(async () => {
      wheelUp.dispatchEvent(tap());
      wheelDown.dispatchEvent(tap());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(scrolls).toEqual([
      { terminalId: "term_00000000000000000000000000000000", sequence: 1, direction: "up", lines: 3, source: "wheel" },
      { terminalId: "term_00000000000000000000000000000000", sequence: 2, direction: "down", lines: 3, source: "wheel" },
    ]);
    expect(keys).toEqual([]);
  });

  test("上一页 / 下一页 write CSI into the PTY, not SendKeys pageup", async () => {
    bootGuided();
    const texts: string[] = [];
    const keys: string[][] = [];
    const session = live();
    act(() => {
      attachLiveSession({
        ...session,
        sendText: async (_paneId, text) => {
          texts.push(text);
        },
        sendKeys: async (_paneId, batch) => {
          keys.push(batch);
        },
        paneRead: async () => ({ text: "ready", hash: "h" }),
      } as LiveSession);
      commitView();
    });
    const rail = [...app.querySelectorAll(".full-terminal-scroll-btn")] as HTMLButtonElement[];
    const pageUp = rail.find((el) => el.getAttribute("aria-label") === "上一页");
    const pageDown = rail.find((el) => el.getAttribute("aria-label") === "下一页");
    if (!pageUp || !pageDown) throw new Error("missing page buttons");
    const tap = () =>
      new PointerEvent("pointerdown", { pointerId: 1, isPrimary: true, button: 0, bubbles: true, cancelable: true });
    await act(async () => {
      pageUp.dispatchEvent(tap());
      pageDown.dispatchEvent(tap());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(texts).toEqual(["\u001b[5~", "\u001b[6~"]);
    expect(keys).toEqual([]);
  });
});
