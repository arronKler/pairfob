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
import { ProtocolError } from "../../../lib/protocol/errors";
import { attachLiveSession } from "../../computers/catalog-store";
import { setPhase } from "../../connection/connection-store";
import { bindPaneRefresh } from "../../connection/refresh-request";
import { applySnapshot } from "../../dashboard/catalog-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { composeDraft, composeLive, setComposeDraft, setComposeFocused, setComposeLive } from "../compose-store";
import { clearModifiers } from "../keypad/keypad";
import { applyPaneRead, openPaneId, selectPane, setAgentChat, setFullTerminal, setTermSelect } from "../session-store";
import { handlePaneKey, setComposeLive as switchComposeLive } from "./compose";
import { guidedScrollController } from "./guided-scroll";
import { dropQueuedKeys, sendPage } from "./keys";
import { sendGuidedTuiScroll } from "./term";
import type { PaneModel } from "./pane-model";
import { SessionDock } from "./session-dock";
import { SessionPane } from "./session-pane";
import { cancelStop } from "./session-stop";

/**
 * Live input over a slow link: what was typed reaches the program in the order
 * it was typed, characters and keys alike. The text path keeps one write in
 * flight, so a write that is slow to be acknowledged used to let the keys typed
 * after it through first.
 */
const handlers = { onBack() {}, onMenu() {}, onWorkspace() {} };
const parts = {
  Terminal: ({ model }: { model: PaneModel }) => <div data-testid="buffer">{model.texts.join("\n")}</div>,
  RowBar: () => null,
  Dock: SessionDock,
};
const snapshotRestorer = new WorkspaceSnapshotRestorer();
/** What was written to the session, in order: `T` text, `K` keys. */
let wire: string[] = [];
/** Text writes not acknowledged yet, oldest first. */
let slow: Array<{ ack: () => void; fail: (error: unknown) => void }> = [];
/** The wheel bridge's open, answered by the test. */
let opened: Array<(value: { terminalId: string }) => void> = [];
let release = () => {};

function paint(): HTMLTextAreaElement {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  bindSessionOwnerFromLive();
  act(() => {
    renderReact(<SessionPane key={openPaneId()} includeBack={false} handlers={handlers}
      scroll={{ top: 0, left: 0, bottom: true }} parts={parts} />);
  });
  return appRoot().querySelector<HTMLTextAreaElement>(".dock-form textarea")!;
}

function press(name: string, init: Record<string, unknown> = {}): void {
  const event = new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  act(() => { handlePaneKey(event, false); });
}

const settle = () => act(async () => { for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); });
/** Acknowledge the oldest unacknowledged text write. */
const ack = async (): Promise<void> => { slow.shift()?.ack(); await settle(); };

beforeEach(async () => {
  await resetBoardTestDOM();
  resetInputMode();
  setLang("zh");
  wire = [];
  slow = [];
  opened = [];
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
      sendText: (_pane: string, text: string) => {
        wire.push(`T${text}`);
        return new Promise<void>((resolve, reject) => { slow.push({ ack: resolve, fail: reject }); });
      },
      sendKeys: async (_pane: string, keys: string[]) => { wire.push(`K${keys.join(",")}`); },
      terminalOpen: () => new Promise<{ terminalId: string }>((resolve) => { opened.push(resolve); }),
      terminalScroll: async (_id: string, _sequence: number, direction: string, lines: number) => { wire.push(`W${direction}${lines}`); },
      terminalClose: async () => undefined,
    } as unknown as LiveSession);
    applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/repo/project" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/repo/project", agent: "codex", agent_status: "idle" }],
    });
  });
});

afterEach(async () => {
  for (const write of slow.splice(0)) write.ack();
  for (const open of opened.splice(0)) open({ terminalId: "t-end" });
  await settle();
  guidedScrollController.dispose();
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
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("a b ⌫ c typed behind a slow write arrives as a b ⌫ c, not with the Backspace ahead of b", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("a");
  await settle();
  expect(wire).toEqual(["Ta"]);
  // `a` is not acknowledged yet: `b` is held behind it, and the keys wait their turn.
  press("b");
  press("Backspace");
  press("c");
  await settle();
  expect(wire).toEqual(["Ta"]);
  await ack();
  expect(wire).toEqual(["Ta", "Tb", "Kbackspace"]);
  await ack();
  expect(wire).toEqual(["Ta", "Tb", "Kbackspace", "Tc"]);
});

test("ls ⏎ pwd ⏎ runs two commands: neither Enter waits for the text typed after it", async () => {
  paint();
  act(() => { setComposeLive(true); });
  for (const key of ["l", "s", "Enter", "p", "w", "d", "Enter"]) press(key);
  await settle();
  // The first frame writes what was typed in it, then its Enter.
  expect(wire).toEqual(["Tls", "Kenter"]);
  await ack();
  expect(wire).toEqual(["Tls", "Kenter", "Tpwd", "Kenter"]);
});

test("Tab completes what was typed before it, and an arrow between two characters stays between them", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("g");
  await settle();
  press("i");
  press("Tab");
  await settle();
  expect(wire).toEqual(["Tg"]);
  await ack();
  expect(wire).toEqual(["Tg", "Ti", "Ktab"]);
  press("x");
  press("ArrowLeft");
  press("y");
  await settle();
  await ack();
  await ack();
  await ack();
  expect(wire).toEqual(["Tg", "Ti", "Ktab", "Tx", "Kleft", "Ty"]);
});

test("text that fails takes the Enter typed after it along: the draft gets the text back and nothing is run", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("a");
  await settle();
  press("b");
  press("Enter");
  await settle();
  expect(wire).toEqual(["Ta"]);
  slow.shift()!.fail(new ProtocolError("disconnected", "gone"));
  await settle();
  // Back to composed input with what was not delivered; no Enter went out on its own.
  expect(composeLive()).toBeFalse();
  expect(composeDraft()).toBe("ab");
  expect(wire).toEqual(["Ta"]);
});

test("on a quick link nothing waits: every character and key is written as it is typed", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("a");
  await settle();
  await ack();
  press("Backspace");
  expect(wire).toEqual(["Ta", "Kbackspace"]);
  press("Escape");
  await settle();
  expect(wire.slice(2).join("")).toBe("Kesc");
});

const PAGE_UP = "T\x1b[5~";
const PAGE_DOWN = "T\x1b[6~";

test("a PageUp pressed between two characters behind a slow write stays between them", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("a");
  await settle();
  press("b");
  press("PageUp");
  press("c");
  await settle();
  // `b` is held behind `a`; the page key and `c` wait their turn.
  expect(wire).toEqual(["Ta"]);
  await ack();
  expect(wire).toEqual(["Ta", "Tb", PAGE_UP]);
  // The page key's own write is acknowledged like any text write here; `c` follows `b`.
  await ack();
  await ack();
  expect(wire).toEqual(["Ta", "Tb", PAGE_UP, "Tc"]);
});

test("the on-screen page buttons take the same turn as the keys", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("l");
  await settle();
  press("s");
  // The scroll rail's page button and the pad's page key both call this.
  act(() => { sendGuidedTuiScroll("down", 20, "page_key"); });
  press("Enter");
  await settle();
  expect(wire).toEqual(["Tl"]);
  await ack();
  await ack();
  await ack();
  expect(wire).toEqual(["Tl", "Ts", PAGE_DOWN, "Kenter"]);
});

test("a page key waits for a key the queue is still holding, and a key pressed after it waits for the page", async () => {
  paint();
  // Composed input: the order is the session's, not live input's alone.
  press("ArrowUp");
  press("ArrowUp");
  act(() => { void sendPage("up"); });
  press("Escape");
  await settle();
  expect(wire.join(" ")).toBe(`Kup Kup ${PAGE_UP} Kesc`);
});

test("on a quick link a page key is written when it is pressed, after the keys before it", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("a");
  await settle();
  await ack();
  press("Escape");
  press("PageUp");
  await settle();
  expect(wire).toEqual(["Ta", "Kesc", PAGE_UP]);
});

test("a wheel notch whose bridge is still opening keeps the characters and keys typed after it behind it", async () => {
  paint();
  act(() => { setComposeLive(true); });
  act(() => { sendGuidedTuiScroll("up", 3, "wheel"); });
  press("q");
  press("Enter");
  await settle();
  // The bridge has not answered: nothing has been written yet.
  expect(wire).toEqual([]);
  opened.shift()!({ terminalId: "t1" });
  await settle();
  expect(wire).toEqual(["Wup3", "Tq", "Kenter"]);
});

test("a wheel notch asked for behind a held character is written after it", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("a");
  await settle();
  press("b");
  act(() => { sendGuidedTuiScroll("down", 3, "wheel"); });
  await settle();
  expect(wire).toEqual(["Ta"]);
  await ack();
  opened.shift()?.({ terminalId: "t1" });
  await settle();
  expect(wire).toEqual(["Ta", "Tb", "Wdown3"]);
});

test("text that fails gives back the characters that were waiting behind a key too, in order, and sends none of the keys", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("a");
  await settle();
  press("b");
  press("Backspace");
  press("c");
  press("d");
  press("Enter");
  await settle();
  slow.shift()!.fail(new ProtocolError("disconnected", "gone"));
  await settle();
  expect(composeLive()).toBeFalse();
  expect(composeDraft()).toBe("abcd");
  expect(wire).toEqual(["Ta"]);
});

test("leaving live input waits for what is still taking its turn: nothing typed is dropped by the switch", async () => {
  paint();
  act(() => { setComposeLive(true); });
  press("ArrowUp");
  press("ArrowUp");
  press("x");
  let switched = false;
  act(() => { void switchComposeLive(false).then(() => { switched = true; }); });
  await settle();
  await ack();
  await settle();
  expect(wire.join(" ")).toBe("Kup Kup Tx");
  expect(switched).toBeTrue();
  expect(composeLive()).toBeFalse();
});
