import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { bindOverlayOrigin } from "../../shared/ui/overlay";
import { PairCodeSheet } from "./code-sheet";
import type { ConnectViewModel } from "./model";

/**
 * The code sheet follows the gesture like every dialog: a tablet's keyboard
 * beside the list gets the centred card, a finger the sheet that lifts above
 * the soft keyboard.
 */
const view: ConnectViewModel = {
  adding: false, busy: false, stage: "idle", layout: "phone", entry: "scan", backTitle: "", title: "", lede: "",
  ledeTone: "muted", ledeKeycap: false, showInstall: false, sheetOpen: true, fieldNotice: null,
  pairCodeDraft: "", pairCodeLength: 0, pairCodeComplete: false, pairCodeInvalid: false,
};
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.pair-code-sheet")!;
const open = () => renderReact(<PairCodeSheet view={view} onDismiss={() => {}} onPaste={() => {}}
  onSubmit={event => event.preventDefault()} onCodeChange={() => {}} />);
let release = () => {};

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 820, height: 1180 });
  release = bindOverlayOrigin(document);
});
afterEach(() => {
  unmountReact();
  release();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("a key opens the card and a finger the sheet where the list sits beside the page", async () => {
  document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  open();
  await act(async () => { await Promise.resolve(); });
  expect(sheet().className).toBe("modal sheet pair-code-sheet desk-form");
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  unmountReact();
  document.body.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }) as unknown as Event);
  open();
  await act(async () => { await Promise.resolve(); });
  expect(sheet().className).toBe("modal sheet pair-code-sheet");
  expect(document.body.classList.contains("sheet-open")).toBeTrue();
});
