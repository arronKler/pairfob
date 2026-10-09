import { expectSameNode } from "../../../../test-support/node-identity";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { PaneComposePreferenceRestorer } from "../../../../test-support/preferences-restore";
import { appRoot } from "../../../app/dom-root";
import { noteKeydown, resetInputMode } from "../../../app/input-mode";
import { setLang, t } from "../../../lib/i18n";
import { keysExpanded, paneComposeLive, setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { composeLive, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from "../compose-store";
import { selectPane } from "../session-store";
import { emulateTouchDevice } from "../touch-realm";

const { notifyFullTerminalKeyboard } = await import("./full-terminal-input");
const { clearModifiers } = await import("../keypad/keypad");
const { FullTerminalPad } = await import("./full-terminal-pad");

/**
 * The complete-terminal pad on a wide layout: a mouse gets the keys behind
 * "按键", paging in the pad and the input-mode switch; a finger keeps the row,
 * the rail and its keyboard button.
 */
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function keyboard() {
  let open = false;
  let opened = 0;
  return {
    toggle: () => { open = !open; },
    open: () => { open = true; opened += 1; },
    close: () => { open = false; },
    isOpen: () => open,
    opened: () => opened,
  };
}

function paint(size: { width: number; height: number }, extra: Record<string, unknown> = {}) {
  happy.happyDOM.setWindowSize(size);
  const sent: string[] = [];
  const paged: string[] = [];
  const kb = keyboard();
  const options = { sendKey: (key: string) => { sent.push(key); }, sendCompose: () => true, keyboard: kb, hardwareKeyboard: true, ...extra };
  act(() => { renderReact(createElement(FullTerminalPad, { options, onPage: (direction: "up" | "down") => { paged.push(direction); } })); });
  return { sent, paged, kb };
}

const root = () => appRoot();
const keysButton = () => root().querySelector<HTMLButtonElement>(".dock-keys-btn");
const modeOption = (label: string) =>
  [...root().querySelectorAll<HTMLButtonElement>(".dock-mode-option")].find((el) => el.textContent === label);
const keyLabels = () =>
  [...root().querySelectorAll<HTMLButtonElement>(".keys .key")].map((el) => el.getAttribute("aria-label") ?? el.textContent);

const composeRestorer = new PaneComposePreferenceRestorer();
let restorePointer: (() => void) | null = null;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  selectPane("p1");
  composeRestorer.capture("p1");
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeLive(false);
});

afterEach(async () => {
  unmountReact();
  restorePointer?.();
  restorePointer = null;
  resetInputMode();
  await act(async () => {
    notifyFullTerminalKeyboard(false);
    clearModifiers();
    setComposeDraft("");
    setComposeFocused(false);
    setComposeIME(false);
    setComposeLive(false);
    setKeysExpanded(false);
    setPadKind("keys");
  });
  composeRestorer.restore();
  selectPane("");
  happy.happyDOM.setWindowSize(PHONE);
});

describe("complete-terminal pad driven by a mouse beside the list", () => {
  test("the keys wait behind 按键; the pad it opens also pages the terminal", () => {
    const { sent, paged } = paint(DESK);
    expect(root().querySelector(".keys")).toBeNull();
    expect(root().querySelector(".full-terminal-kb")).toBeNull();
    expect(keysButton()?.getAttribute("aria-expanded")).toBe("false");
    expect(root().querySelector(".full-terminal-compose-form .dock-keys-btn")).not.toBeNull();

    act(() => keysButton()!.click());
    expect(keysExpanded()).toBeTrue();
    expect(keyLabels()).toEqual(["Esc", "上箭头", "下箭头", "左箭头", "右箭头", "退格", "上一页", "下一页", "更多按键"]);

    act(() => root().querySelector<HTMLButtonElement>('.keys [aria-label="上一页"]')!.click());
    act(() => root().querySelector<HTMLButtonElement>('.keys [aria-label="下一页"]')!.click());
    expect(paged).toEqual(["up", "down"]);
    // Paging is the terminal's scroll, never a key written to the PTY.
    expect(sent).toEqual([]);

    act(() => root().querySelector<HTMLButtonElement>('.keys [aria-label="Esc"]')!.click());
    expect(sent).toEqual(["esc"]);
  });

  test("组字 / 实时 goes through the controller's switch when it is given one", () => {
    const switched: boolean[] = [];
    paint(DESK, { setLive: (live: boolean) => { switched.push(live); } });
    expect(root().querySelector(".dock-mode-hint")?.textContent).toContain("组字：写完再发，Enter 发送");
    act(() => modeOption("实时")!.click());
    expect(switched).toEqual([true]);
    // Pressing the mode already chosen asks for nothing.
    act(() => modeOption("组字")!.click());
    expect(switched).toEqual([true]);
  });

  test("without one it sets the pane's own input mode, and live shows where the keyboard went", () => {
    const { kb } = paint(DESK);
    act(() => modeOption("实时")!.click());
    expect(composeLive()).toBeTrue();
    expect(paneComposeLive("p1")).toBeTrue();
    expect(root().querySelector(".full-terminal-pad")?.getAttribute("data-input-mode")).toBe("live");
    expect(root().querySelector(".full-terminal-compose-form")).toBeNull();
    const field = root().querySelector(".full-terminal-live-field");
    expect(field?.classList.contains("is-live")).toBeTrue();
    expect(field?.querySelector(".compose-live-tag")?.textContent).toBe("实时");
    // One wording for the mode in both views: the guided live field's label, and its hint with the way out.
    expect(field?.querySelector(".full-terminal-live-label")?.textContent).toBe("实时 · 边打边进终端");
    expect([...root().querySelectorAll(".dock-mode-hint span")].map((el) => el.textContent))
      .toEqual(["实时：每个键都发到会话，F6 移出", "组字：写完再发，Enter 发送"]);
    expect(root().querySelector(".full-terminal-live-actions .dock-keys-btn")).not.toBeNull();

    // The terminal took the keyboard with the mode; the field hands it back after a click elsewhere.
    const before = kb.opened();
    act(() => root().querySelector<HTMLButtonElement>(".full-terminal-live-focus")!.click());
    expect(kb.opened()).toBe(before + 1);

    act(() => modeOption("组字")!.click());
    expect(composeLive()).toBeFalse();
    expect(root().querySelector(".full-terminal-compose-form")).not.toBeNull();
  });
});

/** A connected herd whose pane p1 reports `status`, and the way back. */
async function withAgent(status: string, run: (setStatus: (next: string) => void) => void | Promise<void>) {
  const { setNetworkOnline, setPhase } = await import("../../connection/connection-store");
  const { applyRuntimeIdentity, runtimeIdentity } = await import("../../connection/runtime-store");
  const { attachLiveSession } = await import("../../computers/catalog-store");
  const { applySnapshot } = await import("../../dashboard/catalog-store");
  const { cancelStop } = await import("../guided/session-stop");
  const runtimeBefore = runtimeIdentity();
  const setStatus = (next: string) => applySnapshot({ panes: [{ pane_id: "p1", agent: "codex", agent_status: next, interactive_ready: true }] });
  try {
    act(() => {
      setPhase("live");
      setNetworkOnline(true);
      applyRuntimeIdentity({ herdHost: runtimeBefore.herdHost, runtimeKind: "herdr" });
      attachLiveSession({ isConnected: () => true } as never);
      setStatus(status);
    });
    await run(setStatus);
  } finally {
    act(() => {
      cancelStop();
      applySnapshot({ panes: [] });
      attachLiveSession(null);
      applyRuntimeIdentity(runtimeBefore);
    });
  }
}

const liveStop = () => root().querySelector<HTMLButtonElement>(".full-terminal-live-actions .full-terminal-live-stop");

describe("停止 in the mouse-driven dock", () => {
  test("live input keeps it beside 按键 while the agent works, writing Esc like the compose form's", async () => {
    await withAgent("working", (setStatus) => {
      const sent: Array<[string, boolean]> = [];
      paint(DESK, { sendCompose: (text: string, enter: boolean) => { sent.push([text, enter]); return true; } });
      // 组字: the send button is the stop.
      expect(root().querySelector<HTMLButtonElement>(".full-terminal-compose-send")?.dataset.sendKind).toBe("stop");
      expect(liveStop()).toBeNull();

      act(() => modeOption("实时")!.click());
      const row = [...root().querySelector(".full-terminal-live-actions")!.children].map((el) => el.className.split(" ")[0]);
      expect(row.slice(-2)).toEqual(["dock-keys-btn", "full-terminal-compose-send"]);
      expect(liveStop()?.dataset.sendKind).toBe("stop");
      expect(liveStop()?.getAttribute("aria-label")).toBe("停止当前任务");

      act(() => liveStop()!.click());
      expect(sent).toEqual([["\u001b", false]]);
      expect(liveStop()?.dataset.sendKind).toBe("stopping");
      expect(liveStop()?.disabled).toBeTrue();

      // Herdr reports the pane left working: the flow ends and the button goes with it.
      act(() => setStatus("idle"));
      expect(liveStop()).toBeNull();
      expect(sent).toHaveLength(1);
    });
  });

  test("an idle agent has none, and a finger's live pad never does", async () => {
    await withAgent("idle", () => {
      act(() => { setComposeLive(true); });
      paint(DESK);
      expect(root().querySelector(".full-terminal-live-field")).not.toBeNull();
      expect(liveStop()).toBeNull();
    });
    unmountReact();
    await withAgent("working", () => {
      restorePointer = emulateTouchDevice();
      act(() => { setComposeLive(true); });
      paint(DESK, { hardwareKeyboard: false });
      expect(root().querySelector(".full-terminal-live-actions")).not.toBeNull();
      expect(liveStop()).toBeNull();
      unmountReact();
      paint(PHONE, { hardwareKeyboard: false });
      expect(liveStop()).toBeNull();
    });
  });
});

describe("complete-terminal pad on touch", () => {
  test("a tablet's wide layout keeps the key row and its keyboard button", () => {
    restorePointer = emulateTouchDevice();
    act(() => { setComposeLive(true); });
    paint(DESK, { hardwareKeyboard: false });
    expect(keysButton()).toBeNull();
    expect(root().querySelector(".dock-mode")).toBeNull();
    expect(root().querySelector(".full-terminal-live-field")).toBeNull();
    expect(root().querySelector(".full-terminal-kb")).not.toBeNull();
    expect(keyLabels()).toEqual(["Esc", "上箭头", "下箭头", "左箭头", "右箭头", "退格", "更多按键"]);
  });

  test("a tablet's keyboard, once proved, is told the way out of live input in the row that is already there", () => {
    restorePointer = emulateTouchDevice();
    act(() => { setComposeLive(true); });
    paint(DESK);
    const hint = () => root().querySelector(".full-terminal-live-actions > .full-terminal-live-hint");
    const rows = () => [...root().querySelector(".full-terminal-pad")!.children].map((child) => child.className);
    const attach = root().querySelector(".attach-btn")!;
    const shape = rows();
    expect(hint()).toBeNull();
    act(() => noteKeydown());
    expect(hint()?.textContent).toBe(t("deskDock.liveKeysPh"));
    expect(hint()?.textContent).toMatch(/F6/);
    // No row is added for it: a taller pad would resize the terminal on the computer at the first key.
    expect(rows()).toEqual(shape);
    expect(root().querySelector(".dock-mode")).toBeNull();
    expectSameNode(root().querySelector(".attach-btn"), attach);
    // 组字 has its field to say it in.
    act(() => { setComposeLive(false); });
    expect(hint()).toBeNull();
    expect(root().querySelector<HTMLTextAreaElement>(".full-terminal-compose-input")!.placeholder).toBe(t("deskDock.batchKeysPh"));
  });

  test("a mouse has its hint line instead, and a phone that reported a key has neither", () => {
    act(() => { setComposeLive(true); });
    paint(DESK);
    expect(root().querySelector(".full-terminal-live-hint")).toBeNull();
    expect(root().querySelector(".dock-mode-hint")?.textContent).toMatch(/F6/);
    unmountReact();
    restorePointer = emulateTouchDevice();
    act(() => noteKeydown());
    paint(PHONE);
    expect(root().querySelector(".full-terminal-live-hint")).toBeNull();
    expect(root().querySelector(".dock-mode")).toBeNull();
  });

  test("the phone pad is the same markup whatever points at it, but for what the field says about Send", () => {
    const field = () => root().querySelector<HTMLTextAreaElement>(".full-terminal-compose-input")!;
    // The placeholder follows the keyboard, as Enter does: set aside, the rest must match.
    const markup = () => root().innerHTML.replace(` placeholder="${field().placeholder}"`, "");
    paint(PHONE);
    const withMouse = markup();
    expect(field().placeholder).toBe("组字 · 写完再发送");
    expect(keysButton()).toBeNull();
    expect(root().querySelector(".dock-mode")).toBeNull();
    unmountReact();
    restorePointer = emulateTouchDevice();
    paint(PHONE);
    expect(field().placeholder).toBe("组字 · 写完点发送");
    expect(markup()).toBe(withMouse);
  });
});
