import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { clearNotice, visibleNotice } from "../../app/notices-store";
import { phase, setPhase } from "../connection/connection-store";
import { setLang, t } from "../../lib/i18n";
import { beginPairing, setPairCode } from "./actions";
import { PairCodeField } from "./code-field";
import { pairCodeDraft, resetPairingInput } from "./form-store";
import { usePairing } from "./hooks";
import { connectViewModel } from "./model";

/**
 * An entry longer than a code. The field keeps all of it, says so while it is
 * typed or pasted, and Connect sends nothing until it is fourteen characters.
 */
let root: Root;
let host: HTMLDivElement;

function Form({ sheet }: { sheet: boolean }) {
  const pairing = usePairing();
  const notice = visibleNotice();
  const view = connectViewModel({
    ...pairing, pairManualOpen: sheet || pairing.pairManualOpen, phase: phase(), addingComputer: false, computerCount: 0,
    fragment: null, notice: notice ? { text: notice.text, tone: notice.tone } : null,
    wide: false, finePointer: !sheet,
  });
  return <form className="connect-form"><PairCodeField view={view} placeholder="Code" onCodeChange={setPairCode} /></form>;
}

function mount(sheet: boolean): void {
  act(() => root.render(<Form sheet={sheet} />));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("en");
  act(() => { setPhase("connect"); resetPairingInput(); clearNotice(); });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => { resetPairingInput(); clearNotice(); setPhase("boot"); });
  setLang("zh");
});

const input = () => host.querySelector("input")!;
const feedback = () => host.querySelector("#pair-feedback")!;
const count = () => host.querySelector(".field-count")!;
/** Compared with the number kept against its unit, as the sentence is drawn. */
const plain = (text: string | null | undefined) => (text ?? "").replaceAll(" ", " ");

function type(value: string): void {
  const field = input();
  act(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new happy.InputEvent("input", { bubbles: true, inputType: "insertText" }) as unknown as Event);
    field.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

for (const sheet of [false, true]) {
  test(`twenty plain characters stay in the ${sheet ? "sheet's" : "card's"} field, and the message and the counter say so at once`, () => {
    mount(sheet);
    const field = input();
    // Nothing of the browser's cuts a paste short behind the reader's back.
    expect(field.hasAttribute("maxlength")).toBeFalse();
    type("abcd2345abcd2345abcd");
    expectSameNode(input(), field);
    expect(field.value).toBe("abcd2345abcd2345abcd");
    expect(pairCodeDraft()).toBe("abcd2345abcd2345abcd");
    expect(plain(feedback().textContent)).toBe("The pairing code is too long: it should have 14 characters, 20 recognized.");
    expect(feedback().getAttribute("role")).toBe("alert");
    expect(host.querySelector(".pair-help")!.classList.contains("is-error")).toBeTrue();
    expect(count().textContent).toBe("20/14");
    expect(count().className).toBe("field-count over");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    // Back to fourteen: the message, the mark and the colour go with the extra characters.
    type("abcd2345abcd23");
    expect(plain(feedback().textContent)).toBe(t("connect.pairHelp"));
    expect(count().className).toBe("field-count ok");
    expect(field.hasAttribute("aria-invalid")).toBeFalse();
  });
}

test("separators and stray marks are not counted as characters of the code", () => {
  mount(false);
  type("ABCD.2345.ABCD.23456");
  expect(count().textContent).toBe("17/14");
  expect(plain(feedback().textContent)).toContain("14 characters, 17 recognized");
  type("abcd-2345 abcd23");
  expect(count().textContent).toBe("14/14");
  expect(count().className).toBe("field-count ok");
});

test("Connect turns an over-long entry away with everything still in the field: nothing is cut to fit and sent", async () => {
  mount(false);
  type("abcd2345abcd2345abcd");
  await act(async () => { await beginPairing(input().value); });
  expect(phase()).toBe("connect");
  expect(input().value).toBe("abcd2345abcd2345abcd");
  expect(pairCodeDraft()).toBe("abcd2345abcd2345abcd");
  expect(plain(feedback().textContent)).toBe("The pairing code is too long: it should have 14 characters, 20 recognized.");
});
