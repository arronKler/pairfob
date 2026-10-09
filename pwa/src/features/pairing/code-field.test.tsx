import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PairCodeField } from "./code-field";
import { connectViewModel } from "./model";
import { pairingStore, resetPairingInput, setPairCodeDraft } from "./form-store";
import { usePairing } from "./hooks";
import { resolveHandPairing } from "../../lib/pairing-input";

let root: Root;
let host: HTMLDivElement;

function Form() {
  const pairing = usePairing();
  const view = connectViewModel({
    ...pairing, phase: "connect", addingComputer: false, computerCount: 0,
    fragment: null, notice: null, wide: false, finePointer: false,
  });
  return <form><PairCodeField view={view} placeholder="Code" onCodeChange={setPairCodeDraft} /></form>;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetPairingInput();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Form />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetPairingInput();
});

function input(): HTMLInputElement {
  return host.querySelector("input")!;
}

function edit(value: string, caret = value.length, composing = false): void {
  const field = input();
  act(() => {
    field.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new happy.InputEvent("input", {
      bubbles: true, inputType: composing ? "insertCompositionText" : "insertText", isComposing: composing,
    }) as unknown as Event);
    // React's Happy DOM change-event fallback also listens for keyup.
    field.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

test("IME preedit and commit preserve the browser's text, selection and node", () => {
  const field = input();
  act(() => {
    field.focus();
    field.dispatchEvent(new happy.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event);
  });
  for (const draft of ["a", "abcd", "abcde", "abcdefghjkmnpq"]) {
    edit(draft, draft.length, true);
    expect(pairingStore.get().pairCodeDraft).toBe(draft);
    expect(field.value).toBe(draft);
    expect(field.selectionStart).toBe(draft.length);
    expect(input() === field).toBe(true);
  }
  act(() => field.dispatchEvent(new happy.CompositionEvent("compositionend", {
    bubbles: true, data: "abcdefghjkmnpq",
  }) as unknown as Event));
  edit("abcdefghjkmnpq");
  expect(field.value).toBe("abcdefghjkmnpq");
  expect(resolveHandPairing(2, field.value, false)).toEqual({ ok: true, code: "ABCDEFGH", loc: "JKMNPQ" });
});

test("typing separators and deleting or replacing in the middle does not move the caret", () => {
  edit("abcd-");
  expect(input().value).toBe("abcd-");
  edit("abcd-efgh-jkmnpq");
  edit("abcdefgh-jkmnpq", 4);
  expect(input().value).toBe("abcdefgh-jkmnpq");
  expect(input().selectionStart).toBe(4);
  edit("ab2defgh-jkmnpq", 3);
  expect(input().value).toBe("ab2defgh-jkmnpq");
  expect(input().selectionStart).toBe(3);
});

test("ordinary input stays literal and an extra character is rejected instead of silently truncated", () => {
  edit("7k3m9h2pwj3k9m");
  expect(input().value).toBe("7k3m9h2pwj3k9m");
  expect(host.querySelector(".field-count")?.textContent).toBe("14/14");
  expect(resolveHandPairing(2, input().value, false)).toEqual({ ok: true, code: "7K3M9H2P", loc: "WJ3K9M" });
  edit("7k3m9h2pwj3k9mx");
  expect(input().value).toBe("7k3m9h2pwj3k9mx");
  expect(resolveHandPairing(2, input().value, false).ok).toBe(false);
});
