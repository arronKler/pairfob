import { expectSameNode } from "../../../../test-support/node-identity";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { PaneComposePreferenceRestorer } from "../../../../test-support/preferences-restore";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import { setScreen } from "../../../app/navigation-store";
import type { LiveSession } from "../../../lib/protocol/client";
import { attachLiveSession } from "../../computers/catalog-store";
import { keysExpanded, paneComposeLive, setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { composeLive, setComposeDraft, setComposeFocused, setComposeLive } from "../compose-store";
import { applyPaneRead, selectPane, setFullTerminal } from "../session-store";
import { emulateTouchDevice } from "../touch-realm";

const { bindPaneRefresh } = await import("../../connection/refresh-request.ts");
const { clearModifiers } = await import("../keypad/keypad");
const { SessionDock } = await import("./session-dock");
const { focusCompose } = await import("./compose");
const { noteKeydown, resetInputMode } = await import("../../../app/input-mode");

/**
 * The guided dock on a wide layout. Width decides the layout and the pointer
 * decides the interaction: a mouse gets the keys behind "按键" and the input-mode
 * switch, a finger on the same layout keeps the key row, and the phone keeps
 * everything it had.
 */
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const root = () => appRoot();
const keysButton = () => root().querySelector<HTMLButtonElement>(".dock-keys-btn");
const placeholder = () => root().querySelector<HTMLTextAreaElement>(".dock-form textarea")?.placeholder;
const modeOption = (label: string) =>
  [...root().querySelectorAll<HTMLButtonElement>(".frame-mode-option")].find((el) => el.textContent === label);
const keyLabels = () =>
  [...root().querySelectorAll<HTMLButtonElement>(".keys .key")].map((el) => el.getAttribute("aria-label") ?? el.textContent);

/** `phone` is what the pane passes: no hardware keyboard, so Return adds a line. */
function paint(size: { width: number; height: number }, includeBack = false, phone = includeBack): void {
  happy.happyDOM.setWindowSize(size);
  act(() => { renderReact(createElement(SessionDock, { includeBack, phone })); });
}

const composeRestorer = new PaneComposePreferenceRestorer();
let restorePointer: (() => void) | null = null;
let sent: Array<[string, string]> = [];

beforeEach(async () => {
  await resetBoardTestDOM();
  // The assertions below read Chinese copy; an earlier file may have left English.
  setLang("zh");
  unmountReact();
  root().replaceChildren();
  sent = [];
  setScreen("pane");
  selectPane("p1");
  composeRestorer.capture("p1");
  applyPaneRead("before", "old");
  setFullTerminal(false);
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeLive(false);
  bindPaneRefresh(async () => null);
  attachLiveSession({
    sendText: async (paneId: string, text: string) => { sent.push([paneId, text]); },
    sendKeys: async () => undefined,
    isConnected: () => true,
  } as unknown as LiveSession);
});

afterEach(() => {
  unmountReact();
  restorePointer?.();
  restorePointer = null;
  resetInputMode();
  clearModifiers();
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeLive(false);
  setComposeFocused(false);
  setComposeDraft("");
  composeRestorer.restore();
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
  root().replaceChildren();
  happy.happyDOM.setWindowSize(PHONE);
});

describe("guided dock driven by a mouse beside the list", () => {
  test("the key row waits behind 按键, which opens the existing expanded pad", () => {
    paint(DESK);
    expect(root().querySelector(".keys")).toBeNull();
    expect(root().querySelector(".keys-wrap")).toBeNull();
    expect(keysButton()?.textContent).toBe("按键");
    expect(keysButton()?.getAttribute("aria-expanded")).toBe("false");
    expect(root().querySelector(".dock-form textarea")?.id).toBe("compose-text-desktop");

    act(() => keysButton()!.click());
    // One state, the one the touch row's ⋯ toggles.
    expect(keysExpanded()).toBeTrue();
    expect(keysButton()?.getAttribute("aria-expanded")).toBe("true");
    expect(keyLabels()).toEqual(["Esc", "上箭头", "下箭头", "左箭头", "右箭头", "退格", "上一页", "下一页", "收起到主键"]);
    expect(root().querySelector(".keys.keys-paged")).not.toBeNull();
    expect(root().querySelector(".pad-pages")).not.toBeNull();

    act(() => keysButton()!.click());
    expect(keysExpanded()).toBeFalse();
    expect(root().querySelector(".keys")).toBeNull();
  });

  test("⋯ folds the panel to its primary row, and its handle puts it away", () => {
    setKeysExpanded(true);
    paint(DESK);
    const panel = root().querySelector<HTMLElement>(".pad-panel")!;
    expect(panel.dataset.panel).toBe("pages");
    act(() => root().querySelector<HTMLButtonElement>(".key-more")!.click());
    expect(panel.dataset.panel).toBe("rail");
    expect(root().querySelector(".pad-pages")).not.toBeNull();
    expect(keysExpanded()).toBeTrue();
    expect(keysButton()?.getAttribute("aria-expanded")).toBe("true");
    act(() => root().querySelector<HTMLButtonElement>(".pad-panel-handle")!.click());
    expect(keysExpanded()).toBeFalse();
    expect(root().querySelector(".pad-panel")).toBeNull();
    expect(keysButton()?.getAttribute("aria-expanded")).toBe("false");
  });

  test("PgUp and PgDn in the pad page the session like the hidden scroll rail", async () => {
    setKeysExpanded(true);
    paint(DESK);
    const key = (label: string) => root().querySelector<HTMLButtonElement>(`.keys [aria-label="${label}"]`)!;
    await act(async () => { key("上一页").click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { key("下一页").click(); await Promise.resolve(); await Promise.resolve(); });
    expect(sent).toEqual([["p1", "\u001b[5~"], ["p1", "\u001b[6~"]]);
  });

  test("组字 / 实时 folds into the field and drives the pane's own input mode", async () => {
    paint(DESK);
    const dock = root().querySelector(".dock")!;
    expect(dock.querySelector(".dock-mode-hint")).toBeNull();
    const frame = root().querySelector(".compose-field");
    expect(frame?.querySelector(".frame-mode")).not.toBeNull();
    expect(modeOption("组字")?.getAttribute("aria-pressed")).toBe("true");
    expect(modeOption("实时")?.getAttribute("aria-pressed")).toBe("false");

    // The switch is one node through the change and stays inside the field.
    const track = root().querySelector(".frame-mode");
    await act(async () => { modeOption("实时")!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(composeLive()).toBeTrue();
    expectSameNode(root().querySelector(".frame-mode"), track);
    expect([...root().querySelectorAll(".frame-mode-option")].map((el) => el.textContent))
      .toEqual(["组字", "实时"]);
    // The same per-pane choice the ··· panel's 输入 control writes.
    expect(paneComposeLive("p1")).toBeTrue();
    expect(modeOption("实时")?.getAttribute("aria-pressed")).toBe("true");
    // Live stays marked on the field itself.
    expect(root().querySelector(".dock-form")?.classList.contains("live")).toBeTrue();
    expect(root().querySelector(".compose-field")?.classList.contains("is-live")).toBeTrue();
    expect(root().querySelector(".compose-field")?.classList.contains("has-mode")).toBeTrue();

    await act(async () => { modeOption("组字")!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(composeLive()).toBeFalse();
    expect(paneComposeLive("p1")).toBeFalse();
  });

  test("the empty field does not tell a mouse to tap", () => {
    paint(DESK);
    expect(placeholder()).toBe("组字 · 写完再发送");
  });

  test("nor in the phone layout: a narrow window with a keyboard sends on Enter all the same", () => {
    paint(PHONE, true, false);
    expect(placeholder()).toBe("组字 · 写完再发送");
    unmountReact();
    // The phone itself: Return adds a line, and Send is a tap.
    restorePointer = emulateTouchDevice();
    paint(PHONE, true);
    expect(placeholder()).toBe("组字 · 写完点发送");
  });

  test("with the list hidden behind the inspector the back button does not make it a phone field", () => {
    paint(DESK, true);
    expect(keysButton()).not.toBeNull();
    expect(root().querySelector(".frame-mode")).not.toBeNull();
  });
});

describe("guided dock on a touch tablet", () => {
  test("the wide layout leaves the keys behind their button and the input mode in the panel", () => {
    restorePointer = emulateTouchDevice();
    paint(DESK, false, true);
    expect(keysButton()).not.toBeNull();
    expect(keysButton()?.querySelector(".keys-word")).toBeNull();
    expect(root().querySelector(".frame-mode")).toBeNull();
    expect(keyLabels()).toEqual([]);
    expect(root().querySelector(".keys.keys-paged")).toBeNull();
    expect(placeholder()).toBe("组字 · 写完点发送");

    act(() => keysButton()!.click());
    expect(root().querySelector(".keys")).not.toBeNull();
    expect(root().querySelector(".pad-pages")).not.toBeNull();
  });

  test("once its keyboard has sent a key, the field stops telling a finger to tap", () => {
    // Enter sends from then on (the pane passes `phone` false), and the
    // placeholder follows that fact rather than the pointer: still no mouse.
    restorePointer = emulateTouchDevice();
    paint(DESK, false, false);
    expect(keysButton()).not.toBeNull();
    expect(placeholder()).toBe("组字 · 写完再发送");
  });
});

describe("a touch tablet whose keyboard has proved itself", () => {
  const field = () => root().querySelector<HTMLTextAreaElement>(".dock-form textarea")!;

  test("the field says what its keys do, in place: no hint line is added under it", () => {
    restorePointer = emulateTouchDevice();
    paint(DESK, false, false);
    const before = field();
    const rows = () => [...root().querySelector(".dock")!.children].map((child) => child.className);
    const shape = rows();
    act(() => noteKeydown());
    // The same field and the same rows: the dock keeps its height, and the terminal above it its size.
    expectSameNode(field(), before);
    expect(rows()).toEqual(shape);
    expect(root().querySelector(".dock-mode-hint")).toBeNull();
    expect(placeholder()).toBe("组字 · Enter 发送");
    // Live input keeps every key, so the way out leads the line.
    act(() => setComposeLive(true));
    expect(placeholder()).toBe("实时 · 按 F6 移出，其余每个键都发到会话");
    setLang("en");
    act(() => setComposeLive(false));
    act(() => setComposeLive(true));
    expect(placeholder()).toBe("Live · F6 leaves; every other key is sent");
  });

  test("under a mouse the switch is in the field and the field keeps its own words", () => {
    paint(DESK);
    act(() => setComposeLive(true));
    expect(placeholder()).toBe("实时 · 边打边进终端");
    expect(root().querySelector(".dock-mode-hint")).toBeNull();
    expect(root().querySelector(".frame-mode")).not.toBeNull();
  });

  test("a phone that reported a key says nothing new", () => {
    restorePointer = emulateTouchDevice();
    act(() => noteKeydown());
    paint(PHONE, true);
    expect(placeholder()).toBe("组字 · 写完点发送");
    act(() => setComposeLive(true));
    expect(placeholder()).toBe("实时 · 边打边进终端");
  });
});

describe("handing the keyboard to the field without a tap (a session opened from the board)", () => {
  const field = () => root().querySelector<HTMLTextAreaElement>(".dock-form textarea")!;
  const handed = () => { act(() => focusCompose()); return document.activeElement === field(); };

  test("a mouse-driven desk takes it", () => {
    paint(DESK);
    expect(handed()).toBeTrue();
  });

  test("a touch tablet's field waits for its tap, until a hardware key proves a keyboard", () => {
    restorePointer = emulateTouchDevice();
    paint(DESK);
    expect(handed()).toBeFalse();
    act(() => noteKeydown());
    expect(handed()).toBeTrue();
  });

  test("a phone's field waits for its tap too: opening a session never raises the keys uninvited", () => {
    restorePointer = emulateTouchDevice();
    paint(PHONE, true);
    expect(handed()).toBeFalse();
    // A key its on-screen keyboard reported is not a hardware keyboard on a phone layout.
    act(() => noteKeydown());
    expect(handed()).toBeFalse();
  });

  test("a narrow window driven by a mouse has a keyboard, and takes it", () => {
    paint(PHONE, true);
    expect(handed()).toBeTrue();
  });
});

describe("guided dock on the phone", () => {
  test("one row, with the keys behind their icon and no mode line", () => {
    paint(PHONE, true);
    expect(keysButton()).not.toBeNull();
    expect(keysButton()?.getAttribute("aria-expanded")).toBe("false");
    expect(root().querySelector(".frame-mode")).toBeNull();
    expect(keyLabels()).toEqual([]);
    expect(root().querySelector(".dock-form textarea")?.id).toBe("compose-text-mobile");
    expect(placeholder()).toBe("组字 · 写完点发送");

    unmountReact();
    restorePointer = emulateTouchDevice();
    paint(PHONE, true);
    expect(keysButton()?.querySelector(".keys-word")).toBeNull();
    expect(keyLabels()).toEqual([]);
    expect(root().querySelector(".frame-mode")).toBeNull();
  });
});
