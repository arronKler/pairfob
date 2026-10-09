import { resetBoardTestDOM, happy } from "../../../../test-support/dom";
import { expectDifferentNode, expectSameNode } from "../../../../test-support/node-identity";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../../app/dom-root";
import { bindInputMode, hardwareKeyboard, resetInputMode } from "../../../app/input-mode";
import { setScreen } from "../../../app/navigation-store";
import { clearNotice } from "../../../app/notices-store";
import { setLang } from "../../../lib/i18n";
import type { LiveSession } from "../../../lib/protocol/client";
import { attachLiveSession } from "../../computers/catalog-store";
import { setPhase } from "../../connection/connection-store";
import { bindPaneRefresh } from "../../connection/refresh-request";
import { applySnapshot } from "../../dashboard/catalog-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { composeDraft, setComposeDraft, setComposeFocused, setComposeLive } from "../compose-store";
import { clearModifiers } from "../keypad/keypad";
import { emulateTouchDevice } from "../touch-realm";
import { applyPaneRead, openPaneId, selectPane, setAgentChat, setFullTerminal, setTermSelect } from "../session-store";
import { handlePaneKey } from "./compose";
import { dropQueuedKeys } from "./keys";
import type { PaneModel } from "./pane-model";
import { SessionDock } from "./session-dock";
import { SessionPane } from "./session-pane";
import { cancelStop } from "./session-stop";

/**
 * A hardware keyboard at the guided session, beside the list.
 *
 * In 实时 the keyboard is the session's: the keys the pad has no cap for (Home,
 * Delete, F5, a modified arrow) go to the program as a terminal would send
 * them. In 组字 they are the draft's, and Tab leaves the field once there are
 * words in it.
 */
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const handlers = { onBack() {}, onMenu() {}, onWorkspace() {} };
const parts = {
  Terminal: ({ model }: { model: PaneModel }) => <div data-testid="buffer">{model.texts.join("\n")}</div>,
  RowBar: () => null,
  Dock: SessionDock,
};

const snapshotRestorer = new WorkspaceSnapshotRestorer();
/** What reached the session: the bytes written to the PTY, and the keys sent by name. */
let bytes = "";
let named: string[] = [];
let release = () => {};

function paint(): HTMLTextAreaElement {
  happy.happyDOM.setWindowSize(DESK);
  bindSessionOwnerFromLive();
  act(() => {
    renderReact(<SessionPane key={openPaneId()} includeBack={false} handlers={handlers}
      scroll={{ top: 0, left: 0, bottom: true }} parts={parts} />);
  });
  return appRoot().querySelector<HTMLTextAreaElement>(".dock-form textarea")!;
}

/** A key pressed in the compose field, which hands it to the pane as the page listener does for the page. */
function key(target: HTMLElement, name: string, init: Record<string, unknown> = {}): KeyboardEvent {
  const event = new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  act(() => {
    if (target === document.body) handlePaneKey(event, false);
    else target.dispatchEvent(event);
  });
  return event;
}

const flush = () => act(async () => { for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(async () => {
  await resetBoardTestDOM();
  resetInputMode();
  setLang("zh");
  bytes = "";
  named = [];
  snapshotRestorer.capture();
  release = bindInputMode(document);
  bindPaneRefresh(async () => null);
  act(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("first output", "hash");
    setTermSelect(false);
    setAgentChat(false);
    setFullTerminal(false);
    setComposeLive(false);
    attachLiveSession({
      isConnected: () => true,
      sendText: async (_pane: string, text: string) => { bytes += text; },
      sendKeys: async (_pane: string, keys: string[]) => { named.push(...keys); },
    } as unknown as LiveSession);
    applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/repo/project" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/repo/project", agent: "codex", agent_status: "idle" }],
    });
  });
});

afterEach(() => {
  act(() => { unmountReact(); });
  release();
  resetInputMode();
  cancelStop();
  dropQueuedKeys();
  clearModifiers();
  act(() => { setComposeDraft(""); setComposeFocused(false); setComposeLive(false); clearNotice(); });
  setScreen("home");
  attachLiveSession(null);
  snapshotRestorer.restore();
  happy.happyDOM.setWindowSize(PHONE);
});

const ESC = "\x1b";

describe("guided 实时 with a hardware keyboard", () => {
  test("Home, End, Delete, Insert and the function keys reach the program from the field", async () => {
    const field = paint();
    act(() => { setComposeLive(true); field.focus(); });
    for (const name of ["Home", "End", "Delete", "Insert", "F1", "F5", "F12"]) {
      expect(key(field, name).defaultPrevented, name).toBeTrue();
    }
    await flush();
    expect(bytes).toBe([`${ESC}[H`, `${ESC}[F`, `${ESC}[3~`, `${ESC}[2~`, `${ESC}OP`, `${ESC}[15~`, `${ESC}[24~`].join(""));
    expect(named).toEqual([]);
  });

  test("and from the page, where the same keydown arrives when nothing has focus", async () => {
    paint();
    act(() => { setComposeLive(true); });
    expect(key(document.body, "Home").defaultPrevented).toBeTrue();
    expect(key(document.body, "F2", { shiftKey: true }).defaultPrevented).toBeTrue();
    await flush();
    expect(bytes).toBe(`${ESC}[H${ESC}[1;2Q`);
  });

  test("a modified arrow, Backspace or Enter keeps its modifier", async () => {
    const field = paint();
    act(() => { setComposeLive(true); field.focus(); });
    key(field, "ArrowUp", { shiftKey: true });
    key(field, "ArrowRight", { ctrlKey: true });
    key(field, "ArrowLeft", { altKey: true });
    key(field, "Backspace", { altKey: true });
    key(field, "Enter", { altKey: true });
    key(field, "PageUp", { ctrlKey: true });
    key(field, "[", { ctrlKey: true });
    await flush();
    expect(bytes).toBe(`${ESC}[1;2A${ESC}[1;5C${ESC}[1;3D${ESC}\x7f${ESC}\r${ESC}[5;5~${ESC}`);
  });

  test("the keys the pad also has go as they always did, and Command chords stay the browser's", async () => {
    const field = paint();
    act(() => { setComposeLive(true); field.focus(); });
    expect(key(field, "ArrowUp").defaultPrevented).toBeTrue();
    expect(key(field, "Escape").defaultPrevented).toBeTrue();
    expect(key(field, "c", { ctrlKey: true }).defaultPrevented).toBeTrue();
    expect(key(field, "ArrowLeft", { metaKey: true }).defaultPrevented).toBeFalse();
    expect(key(field, "Home", { metaKey: true }).defaultPrevented).toBeFalse();
    await flush();
    expect(named).toEqual(["up", "esc", "ctrl+c"]);
    expect(bytes).toBe("");
  });

  test("Tab, Shift+Tab and Backspace go to the program from the live field and from the page alike", async () => {
    const field = paint();
    act(() => { setComposeLive(true); field.focus(); });
    for (const target of [field, document.body]) {
      expect(key(target, "Tab").defaultPrevented).toBeTrue();
      expect(key(target, "Tab", { shiftKey: true }).defaultPrevented).toBeTrue();
      expect(key(target, "Backspace").defaultPrevented).toBeTrue();
      await flush();
    }
    // Tab and Backspace by name, back-tab as the bytes a terminal writes for it.
    expect(named).toEqual(["tab", "backspace", "tab", "backspace"]);
    expect(bytes).toBe(`${ESC}[Z${ESC}[Z`);
    expectSameNode(document.activeElement, field);
  });

  test("Shift+Enter is a line feed, not a second Enter and not a line in the field", async () => {
    const field = paint();
    act(() => { setComposeLive(true); field.focus(); });
    expect(key(field, "Enter", { shiftKey: true }).defaultPrevented).toBeTrue();
    expect(key(document.body, "Enter", { shiftKey: true }).defaultPrevented).toBeTrue();
    await flush();
    expect(named).toEqual(["ctrl+j", "ctrl+j"]);
    expect(field.value).toBe("");
  });

  test("what a terminal leaves to the browser stays there: Ctrl+Shift with a letter, and paste on Shift+Insert", async () => {
    const field = paint();
    act(() => { setComposeLive(true); field.focus(); });
    for (const target of [field, document.body]) {
      expect(key(target, "C", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBeFalse();
      expect(key(target, "V", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBeFalse();
      expect(key(target, "Insert", { shiftKey: true }).defaultPrevented).toBeFalse();
    }
    await flush();
    expect([bytes, named]).toEqual(["", []]);
  });

  test("a paste pressed on the page finds the live field, where the browser can put it", async () => {
    const field = paint();
    act(() => { setComposeLive(true); field.blur(); });
    expect(key(document.body, "v", { metaKey: true }).defaultPrevented).toBeFalse();
    expectSameNode(document.activeElement, field);
    act(() => { field.blur(); });
    expect(key(document.body, "Insert", { shiftKey: true }).defaultPrevented).toBeFalse();
    expectSameNode(document.activeElement, field);
    // Other Command chords leave focus alone: a copy must still find what the reader selected.
    act(() => { field.blur(); });
    key(document.body, "c", { metaKey: true });
    expectDifferentNode(document.activeElement, field);
    await flush();
    expect([bytes, named]).toEqual(["", []]);
  });

  test("on a phone a drafted field still sends its Tab to the program", async () => {
    const field = paint();
    const matchMedia = window.matchMedia;
    act(() => {
      window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof window.matchMedia;
      happy.happyDOM.setWindowSize(PHONE);
    });
    try {
      act(() => { setComposeLive(false); setComposeDraft("ok"); field.value = "ok"; field.focus(); });
      expect(key(field, "Tab").defaultPrevented).toBeTrue();
      await flush();
      expect(named).toEqual(["tab"]);
    } finally {
      act(() => { window.matchMedia = matchMedia; happy.happyDOM.setWindowSize(DESK); setComposeDraft(""); });
    }
  });

  test("on a phone the live field sends what it always sent: no Home, no function key, Shift+Tab leaves the field", async () => {
    const field = paint();
    const matchMedia = window.matchMedia;
    act(() => {
      window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof window.matchMedia;
      happy.happyDOM.setWindowSize(PHONE);
    });
    try {
      act(() => { setComposeLive(true); field.focus(); });
      for (const [name, init] of [["Home", {}], ["Delete", {}], ["F5", {}], ["Tab", { shiftKey: true }], ["Enter", { shiftKey: true }]] as const) {
        expect(key(field, name, init).defaultPrevented, name).toBeFalse();
      }
      expect(key(document.body, "Backspace").defaultPrevented).toBeFalse();
      expect(key(field, "Tab").defaultPrevented).toBeTrue();
      expect(key(field, "Backspace").defaultPrevented).toBeTrue();
      await flush();
      expect([bytes, named]).toEqual(["", ["tab", "backspace"]]);
    } finally {
      act(() => { window.matchMedia = matchMedia; });
    }
  });
});

describe("a header that changes under the reader's press", () => {
  const render = (includeBack: boolean): void => act(() => {
    renderReact(<SessionPane key={openPaneId()} includeBack={includeBack} handlers={handlers}
      scroll={{ top: 0, left: 0, bottom: true }} parts={parts} />);
  });

  test("the files button keeps the focus its press gave it when the column it opened adds the back button", async () => {
    const field = paint();
    const files = appRoot().querySelector<HTMLButtonElement>(".chrome-actions .icon-workspace")!;
    act(() => { files.focus(); });
    // The field notes that it lost focus a turn after the press, as it does before a click lands.
    await flush();
    // 900–1199: the list gives way to the inspector and the header gains a back button.
    render(true);
    expectSameNode(document.activeElement, files);
    render(false);
    expectSameNode(document.activeElement, files);
    // With focus on the page the same repaint still hands the keyboard to the field.
    act(() => { files.blur(); });
    render(true);
    expectSameNode(document.activeElement, field);
  });
});

describe("a touch tablet's first key in the compose field", () => {
  test("PageUp and PageDown page the session at the first press: the key itself proves the keyboard", async () => {
    const restoreTouch = emulateTouchDevice();
    try {
      const field = paint();
      act(() => { field.focus(); });
      expect(hardwareKeyboard()).toBeFalse();
      expect(key(field, "PageUp").defaultPrevented).toBeTrue();
      expect(hardwareKeyboard()).toBeTrue();
      await flush();
      expect(bytes).toBe(`${ESC}[5~`);
    } finally {
      restoreTouch();
    }
  });

  test("in live input Home and Delete reach the program at the first press too", async () => {
    const restoreTouch = emulateTouchDevice();
    try {
      const field = paint();
      act(() => { setComposeLive(true); field.focus(); });
      expect(key(field, "Home").defaultPrevented).toBeTrue();
      expect(key(field, "Delete").defaultPrevented).toBeTrue();
      await flush();
      expect(bytes).toBe(`${ESC}[H${ESC}[3~`);
    } finally {
      restoreTouch();
    }
  });
});

describe("guided 组字 with a hardware keyboard", () => {
  test("Home, End, Delete and a Shift+arrow selection are the draft's own", async () => {
    const field = paint();
    act(() => { setComposeDraft("git status"); field.value = "git status"; field.focus(); });
    for (const [name, init] of [["Home", {}], ["End", {}], ["Delete", {}], ["ArrowLeft", { shiftKey: true }], ["F5", {}]] as const) {
      expect(key(field, name, init).defaultPrevented, name).toBeFalse();
    }
    await flush();
    expect([bytes, named]).toEqual(["", []]);
  });

  test("Tab completes at an empty prompt, and Shift+Tab there is the keyboard's way out of the field", async () => {
    const field = paint();
    act(() => { field.focus(); });
    expect(key(field, "Tab").defaultPrevented).toBeTrue();
    // Not taken and not sent: the browser moves focus back to the control before the field.
    expect(key(field, "Tab", { shiftKey: true }).defaultPrevented).toBeFalse();
    await flush();
    expect([bytes, named]).toEqual(["", ["tab"]]);
  });

  test("Ctrl+Shift with a letter is left to the browser; Ctrl with a letter is the program's", async () => {
    const field = paint();
    act(() => { field.focus(); });
    expect(key(field, "C", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBeFalse();
    expect(key(document.body, "C", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBeFalse();
    expect(key(field, "c", { ctrlKey: true }).defaultPrevented).toBeTrue();
    await flush();
    expect(named).toEqual(["ctrl+c"]);
  });

  test("with words in the draft Tab leaves the field, forward as it always could backward", async () => {
    const field = paint();
    act(() => { setComposeDraft("git sta"); field.value = "git sta"; field.focus(); });
    // Not taken: the browser moves focus to the next control after the field.
    expect(key(field, "Tab").defaultPrevented).toBeFalse();
    expect(key(field, "Tab", { shiftKey: true }).defaultPrevented).toBeFalse();
    await flush();
    expect([bytes, named]).toEqual(["", []]);
    expect(composeDraft()).toBe("git sta");
  });
});
