import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { composeDraft, composeIME, composeLive, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from "../compose-store";
import { paneComposeLive, setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { selectPane } from "../session-store";
import { PaneComposePreferenceRestorer } from "../../../../test-support/preferences-restore";
const { notifyFullTerminalKeyboard } = await import("./full-terminal-input");
const { setFullTerminalInputMode, submitFullTerminalCompose } = await import("./full-terminal-compose");
const { FullTerminalPad } = await import("./full-terminal-pad");

function keyboard() {
  let open = false;
  return {
    toggle: () => { open = !open; },
    open: () => { open = true; },
    close: () => { open = false; },
    isOpen: () => open,
  };
}

function paint(sendCompose: (text: string, enter: boolean) => boolean) {
  renderReact(<FullTerminalPad options={{
    sendKey: () => undefined,
    sendCompose,
    keyboard: keyboard(),
    desk: false,
  }} />);
}

function dispatchKey(
  input: HTMLTextAreaElement,
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
  keyCode?: number,
): void {
  const view = appRoot().ownerDocument.defaultView!;
  const event = new view.KeyboardEvent(type, { bubbles: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  act(() => { input.dispatchEvent(event); });
}

const app = appRoot();

/** Restore the one persisted per-pane compose choice without resurrecting other daemon maps. */
const paneComposeRestorer = new PaneComposePreferenceRestorer();

beforeEach(async () => {
  await resetBoardTestDOM();
  selectPane("p1");
  paneComposeRestorer.capture("p1");
});

afterEach(async () => {
  unmountReact();
  act(() => { notifyFullTerminalKeyboard(false); });
  setComposeDraft("");
  setComposeFocused(false);
  setComposeIME(false);
  setComposeLive(false);
  setKeysExpanded(false);
  setPadKind("keys");
  paneComposeRestorer.restore("p1");
  appRoot().replaceChildren();
});

describe("React full-terminal compose", () => {
  test("expanding the pad and submitting settled text preserve the focused textarea", async () => {
    setKeysExpanded(false);
    setComposeDraft("draft");
    const sent: string[] = [];
    await act(() => { paint((text) => { sent.push(text); return true; }); });
    const input = app.querySelector("textarea")!;
    act(() => { input.focus(); });
    input.setSelectionRange(1, 3);
    const more = app.querySelector<HTMLButtonElement>(".key-more")!;
    const view = app.ownerDocument.defaultView!;
    const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
    act(() => { more.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    await act(() => { more.click(); });
    expect(document.activeElement === input).toBeTrue();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
    await act(() => { (app.querySelector('[aria-label="Enter"]') as HTMLButtonElement).click(); });
    expect(sent).toEqual(["draft"]);
    expect(document.activeElement === input).toBeTrue();
    const send = app.querySelector<HTMLButtonElement>(".full-terminal-compose-send")!;
    const sendDown = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
    act(() => { send.dispatchEvent(sendDown); });
    expect(sendDown.defaultPrevented).toBe(true);
  });

  test("sends composed text before a distinct Enter command", () => {
    const sent: Array<{ text: string; isolate: boolean | undefined }> = [];
    const send = (data: Uint8Array, options?: { isolate?: boolean }): void => {
      sent.push({ text: new TextDecoder().decode(data), isolate: options?.isolate });
    };
    expect(submitFullTerminalCompose("中文", true, true, send)).toBe(true);
    expect(sent).toEqual([
      { text: "中文", isolate: undefined },
      { text: "\r", isolate: true },
    ]);
    expect(submitFullTerminalCompose("later", false, false, send)).toBe(false);
    expect(sent).toHaveLength(2);
  });

  test("sends an empty compose submission as an Enter command", () => {
    const sent: Uint8Array[] = [];
    expect(submitFullTerminalCompose("", true, true, (data) => sent.push(data))).toBe(true);
    expect(sent).toEqual([new Uint8Array([0x0d])]);
  });

  test("keeps local IME text until the terminal accepts it", async () => {
    setComposeDraft("待发送");
    const attempts: Array<[string, boolean]> = [];
    await act(() => {
      paint((text, enter) => {
        attempts.push([text, enter]);
        return attempts.length > 1;
      });
    });
    const form = app.querySelector(".full-terminal-compose-form") as HTMLFormElement;
    const input = app.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement;
    expect(input.value).toBe("待发送");
    act(() => { form.requestSubmit(); });
    expect(composeDraft()).toBe("待发送");
    act(() => { form.requestSubmit(); });
    expect(attempts).toEqual([["待发送", true], ["待发送", true]]);
    expect(composeDraft()).toBe("");
    expect(input.value).toBe("");
  });

  test("does not submit unfinished composition or Shift+Enter", async () => {
    const sent: string[] = [];
    await act(() => { paint((text) => { sent.push(text); return true; }); });
    const input = app.querySelector("textarea") as HTMLTextAreaElement;
    const view = app.ownerDocument.defaultView!;
    input.value = "拼音";
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    dispatchKey(input, "keydown", { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    act(() => { input.dispatchEvent(new view.Event("compositionend")); });
    dispatchKey(input, "keydown", { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    dispatchKey(input, "keydown", { key: "Enter" });
    expect(sent).toEqual(["拼音"]);
  });

  test("submits Chromium-style composing Enter exactly once after compositionend", async () => {
    const sent: Array<[string, boolean]> = [];
    await act(() => { paint((text, enter) => { sent.push([text, enter]); return true; }); });
    const form = app.querySelector("form") as HTMLFormElement;
    const input = app.querySelector("textarea") as HTMLTextAreaElement;
    const view = app.ownerDocument.defaultView!;
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    input.value = "中文";
    act(() => { input.dispatchEvent(new view.Event("input")); });
    dispatchKey(input, "keydown", { key: "Enter", isComposing: true }, 229);
    expect(sent).toEqual([]);
    act(() => { input.dispatchEvent(new view.Event("compositionend")); });
    input.value = "中文完成";
    act(() => { input.dispatchEvent(new view.Event("input")); });
    dispatchKey(input, "keydown", { key: "Enter", repeat: true });
    act(() => { form.requestSubmit(); });
    dispatchKey(input, "keyup", { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(sent).toEqual([["中文完成", true]]);
    expect(input.value).toBe("");
    expect(composeDraft()).toBe("");
  });

  test("submits WebKit-style Enter when compositionend precedes keydown", async () => {
    const sent: Array<[string, boolean]> = [];
    await act(() => { paint((text, enter) => { sent.push([text, enter]); return true; }); });
    const form = app.querySelector("form") as HTMLFormElement;
    const input = app.querySelector("textarea") as HTMLTextAreaElement;
    const view = app.ownerDocument.defaultView!;
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    input.value = "候选词";
    act(() => { input.dispatchEvent(new view.Event("input")); });
    act(() => { input.dispatchEvent(new view.Event("compositionend")); });
    dispatchKey(input, "keydown", { key: "Enter" }, 229);
    dispatchKey(input, "keydown", { key: "Enter", repeat: true }, 229);
    act(() => { form.requestSubmit(); });
    dispatchKey(input, "keyup", { key: "Enter" });
    expect(sent).toEqual([["候选词", true]]);
  });

  test("preserves an IME draft when delivery is not ready and retries only on a new Enter", async () => {
    const attempts: Array<[string, boolean]> = [];
    await act(() => {
      paint((text, enter) => {
        attempts.push([text, enter]);
        return attempts.length > 1;
      });
    });
    const input = app.querySelector("textarea") as HTMLTextAreaElement;
    const view = app.ownerDocument.defaultView!;
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    input.value = "暂存中文";
    act(() => { input.dispatchEvent(new view.Event("input")); });
    dispatchKey(input, "keydown", { key: "Enter", isComposing: true }, 229);
    act(() => { input.dispatchEvent(new view.Event("compositionend")); });
    dispatchKey(input, "keyup", { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(attempts).toEqual([["暂存中文", true]]);
    expect(input.value).toBe("暂存中文");
    expect(composeDraft()).toBe("暂存中文");

    dispatchKey(input, "keydown", { key: "Enter" });
    dispatchKey(input, "keyup", { key: "Enter" });
    expect(attempts).toEqual([
      ["暂存中文", true],
      ["暂存中文", true],
    ]);
    expect(input.value).toBe("");
  });

  test("expanded pad Enter completes an IME even when blur emits no compositionend", async () => {
    setKeysExpanded(true);
    const sent: Array<[string, boolean]> = [];
    await act(() => { paint((text, enter) => { sent.push([text, enter]); return true; }); });
    const input = app.querySelector("textarea") as HTMLTextAreaElement;
    const view = app.ownerDocument.defaultView!;
    act(() => { input.focus(); });
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    input.value = "屏幕回车";
    act(() => { input.dispatchEvent(new view.Event("input")); });
    await act(async () => {
      (app.querySelector('[aria-label="Enter"]') as HTMLButtonElement).click();
      // The pad Enter's submitter finishes the IME through queued microtasks; those
      // must land before the IME oracles run.
      await Promise.resolve();
      await Promise.resolve();

      expect(sent).toEqual([["屏幕回车", true]]);
      expect(input.value).toBe("");
      expect(composeIME()).toBeFalse();
    });
    // The same press blurs the composing field, which only schedules a 0ms compose
    // blur timer that publishes composeFocused=false; settle that publication timer
    // inside act afterwards so no store publish leaks outside act.
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  });

  test("unmount invalidates a queued IME submit", async () => {
    const sent: string[] = [];
    await act(() => { paint((text) => { sent.push(text); return true; }); });
    const input = app.querySelector("textarea") as HTMLTextAreaElement;
    const view = app.ownerDocument.defaultView!;
    act(() => { input.dispatchEvent(new view.Event("compositionstart")); });
    input.value = "迟到";
    act(() => { input.dispatchEvent(new view.Event("input")); });
    dispatchKey(input, "keydown", { key: "Enter", isComposing: true }, 229);
    unmountReact();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(sent).toEqual([]);
  });

  test("switching modes persists the pane choice and preserves rejected drafts", () => {
    setComposeDraft("not connected");
    let repaints = 0;
    setFullTerminalInputMode(true, () => false, () => { repaints++; });
    expect(composeLive()).toBe(true);
    expect(composeDraft()).toBe("not connected");
    expect(paneComposeLive("p1")).toBe(true);
    expect(repaints).toBe(1);
    setFullTerminalInputMode(false, () => true, () => { repaints++; });
    expect(composeLive()).toBe(false);
    expect(composeDraft()).toBe("not connected");
    expect(paneComposeLive("p1")).toBe(false);
  });
});