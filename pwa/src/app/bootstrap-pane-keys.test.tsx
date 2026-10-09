import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../test-support/dom";
import { setScreen } from "./navigation-store";
import { setPhase } from "../features/connection/connection-store";
import { composeDraft, setComposeDraft } from "../features/session/compose-store";
import { selectPane, setAgentChat, setFullTerminal, setTermSelect } from "../features/session/session-store";
import { attachLiveSession } from "../features/computers/catalog-store";
import { setLang } from "../lib/i18n";
import { bindPaneKeys } from "./pane-keys";
import { dropQueuedKeys, flushKeys } from "../features/session/guided/keys";

/**
 * Page-level pane-key binding vs native modal dialogs.
 *
 * Regression (Ego): the attachment sheet's native `<dialog>` stays open while
 * the focused Insert All button is disabled, dropping focus to <body>. The old
 * target-based guard then let a body-target Escape pass through and forwarded
 * it to the PTY (`^[` observed). Pane keys must be fully skipped whenever a
 * modal dialog is open, while body keys without a modal keep working.
 */
function livePaneState(): void {
  setLang("en");
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(false);
  setAgentChat(false);
  setTermSelect(false);
  setComposeDraft("");
}

let controller: AbortController;
let sent: string[][];

const session = {
  isConnected: () => true,
  sendKeys: async (_paneId: string, keys: string[]) => { sent.push(keys); },
} as never;

beforeEach(async () => {
  await resetBoardTestDOM();
  livePaneState();
  attachLiveSession(session);
  sent = [];
  controller = new AbortController();
  bindPaneKeys(controller.signal);
});

afterEach(() => {
  controller.abort();
  attachLiveSession(null);
  dropQueuedKeys();
});

function keyOn(target: Node, key: string): void {
  const View = document.defaultView!;
  target.dispatchEvent(new View.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

test("without an open modal, body-target pane keys are still forwarded to the PTY", async () => {
  keyOn(document.body, "Escape");
  await act(async () => { await flushKeys(); });
  expect(sent).toEqual([["esc"]]);
});

test("an open native modal blocks body-target Escape and ordinary keys from the pane", async () => {
  const dialog = document.createElement("dialog");
  document.body.appendChild(dialog);
  dialog.showModal();
  expect(dialog.open).toBe(true);

  // Escape while the modal is open: native key handling is left alone, so it
  // closes the modal instead of leaking `^[` into the PTY.
  keyOn(document.body, "Escape");
  await act(async () => { await flushKeys(); });
  expect(sent).toEqual([]);

  // A printable key also must not reach the background compose draft.
  keyOn(document.body, "x");
  await act(async () => { await flushKeys(); });
  expect(composeDraft()).toBe("");

  // Closing the dialog restores normal body pane-key forwarding.
  dialog.close();
  keyOn(document.body, "Escape");
  await act(async () => { await flushKeys(); });
  expect(sent).toEqual([["esc"]]);
});