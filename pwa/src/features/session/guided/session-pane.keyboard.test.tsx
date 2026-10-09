import { expectSameNode } from "../../../../test-support/node-identity";
import { resetBoardTestDOM, happy } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../../app/dom-root";
import { bindInputMode, resetInputMode } from "../../../app/input-mode";
import { setScreen } from "../../../app/navigation-store";
import { clearNotice } from "../../../app/notices-store";
import { setLang } from "../../../lib/i18n";
import type { LiveSession } from "../../../lib/protocol/client";
import { attachLiveSession } from "../../computers/catalog-store";
import { setPhase } from "../../connection/connection-store";
import { applySnapshot } from "../../dashboard/catalog-store";
import { COMPOSE_ENTER_SENDS_KEY, setComposeEnterSends } from "../../settings/preferences-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { setComposeDraft, setComposeFocused, setComposeLive } from "../compose-store";
import { applyPaneRead, openPaneId, selectPane, setAgentChat, setFullTerminal, setTermSelect } from "../session-store";
import { emulateTouchDevice } from "../touch-realm";
import { dropQueuedKeys } from "./keys";
import type { PaneModel } from "./pane-model";
import { SessionDock } from "./session-dock";
import { SessionPane } from "./session-pane";
import { cancelStop } from "./session-stop";

/**
 * A touch tablet that turns out to have a keyboard. The dock renders before
 * any key is pressed, as a field for glass; the first physical key has to turn
 * it into the keyboard's field where it stands, or Return keeps adding lines.
 */
const TABLET = { width: 1180, height: 820 };
const PHONE = { width: 390, height: 844 };

const handlers = { onBack() {}, onMenu() {}, onWorkspace() {} };
const parts = {
  Terminal: ({ model }: { model: PaneModel }) => <div data-testid="buffer">{model.texts.join("\n")}</div>,
  RowBar: () => null,
  Dock: SessionDock,
};

const snapshotRestorer = new WorkspaceSnapshotRestorer();
let sent: string[] = [];
let enterSendsRaw: string | null = null;
let release = () => {};
let restorePointer = () => {};

function paint(size: { width: number; height: number }): HTMLTextAreaElement {
  happy.happyDOM.setWindowSize(size);
  bindSessionOwnerFromLive();
  act(() => {
    renderReact(<SessionPane key={openPaneId()} includeBack={false} handlers={handlers}
      scroll={{ top: 0, left: 0, bottom: true }} parts={parts} />);
  });
  return appRoot().querySelector<HTMLTextAreaElement>(".dock-form textarea")!;
}

function key(target: Node, name: string, init: Record<string, unknown> = {}): KeyboardEvent {
  const event = new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  act(() => { target.dispatchEvent(event); });
  return event;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetInputMode();
  setLang("zh");
  sent = [];
  enterSendsRaw = localStorage.getItem(COMPOSE_ENTER_SENDS_KEY);
  snapshotRestorer.capture();
  restorePointer = emulateTouchDevice();
  release = bindInputMode(document);
  act(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("first output", "hash");
    setTermSelect(false);
    setAgentChat(false);
    setFullTerminal(false);
    setComposeLive(false);
    setComposeEnterSends(false);
    attachLiveSession({
      isConnected: () => true,
      sendText: async (_pane: string, text: string) => { sent.push(text); },
      sendKeys: async () => undefined,
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
  restorePointer();
  resetInputMode();
  cancelStop();
  dropQueuedKeys();
  act(() => { setComposeDraft(""); setComposeFocused(false); clearNotice(); });
  setScreen("home");
  attachLiveSession(null);
  snapshotRestorer.restore();
  if (enterSendsRaw === null) localStorage.removeItem(COMPOSE_ENTER_SENDS_KEY);
  else localStorage.setItem(COMPOSE_ENTER_SENDS_KEY, enterSendsRaw);
  happy.happyDOM.setWindowSize(PHONE);
});

test("the first physical key turns the tablet's field into the keyboard's, in place", async () => {
  const field = paint(TABLET);
  expect(field.id).toBe("compose-text-mobile");
  expect(field.placeholder).toBe("组字 · 写完点发送");
  act(() => { field.value = "draft under edit"; field.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event); });
  field.setSelectionRange(2, 7);
  // Return on glass is a new line: nothing has proved a keyboard yet.
  expect(key(field, "Enter").defaultPrevented).toBeFalse();
  expect(sent).toEqual([]);

  // A key pressed outside any field is one no on-screen keyboard can send.
  key(document.body, "Shift");
  expectSameNode(appRoot().querySelector(".dock-form textarea"), field);
  expect(field.id).toBe("compose-text-desktop");
  // Send is no longer a tap away only: the placeholder says so with the Return rule,
  // and, with no hint line under a finger's field, names the key.
  expect(field.placeholder).toBe("组字 · Enter 发送");
  expect([field.value, field.selectionStart, field.selectionEnd]).toEqual(["draft under edit", 2, 7]);
  expect(appRoot().querySelector(`label[for="compose-text-desktop"]`) !== null).toBeTrue();

  // The keyboard's rule from here on: Shift+Enter is the new line, Enter sends.
  expect(key(field, "Enter", { shiftKey: true }).defaultPrevented).toBeFalse();
  expect(key(field, "Enter").defaultPrevented).toBeTrue();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
});

test("a phone keeps its field and its Return whatever keys arrive", () => {
  const field = paint(PHONE);
  key(document.body, "Shift");
  key(field, "ArrowLeft");
  expect(field.id).toBe("compose-text-mobile");
  expect(field.placeholder).toBe("组字 · 写完点发送");
  act(() => { field.value = "hi"; field.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event); });
  expect(key(field, "Enter").defaultPrevented).toBeFalse();
  expect(sent).toEqual([]);
});
