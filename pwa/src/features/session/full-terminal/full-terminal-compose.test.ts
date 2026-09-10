import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { composeDraft, composeIME, composeLive, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from "../compose-store";
import { paneComposeLive, setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { selectPane } from "../session-store";
import { PaneComposePreferenceRestorer } from "../../../../test-support/preferences-restore";
const {
  setFullTerminalInputMode,
  submitFullTerminalCompose,
} = await import("./full-terminal-compose.ts");
const { FullTerminalPad } = await import("./full-terminal-pad.tsx");
const { notifyFullTerminalKeyboard } = await import("./full-terminal-input.ts");

function keyboard() {
  let open = false;
  return {
    toggle: () => { open = !open; },
    open: () => { open = true; },
    close: () => { open = false; },
    isOpen: () => open,
  };
}

function render(sendCompose: (text: string, enter: boolean) => boolean) {
  const options = {
    sendKey: () => undefined,
    sendCompose,
    keyboard: keyboard(),
    desk: false,
  };
  renderReact(createElement(FullTerminalPad, { options }));
  return appRoot();
}

function viewOf(node: Node) {
  return node.ownerDocument!.defaultView!;
}

function dispatchKey(
  input: HTMLTextAreaElement,
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
  keyCode?: number,
): void {
  const view = viewOf(input);
  const event = new view.KeyboardEvent(type, { bubbles: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  act(() => { input.dispatchEvent(event); });
}

function fire(node: Node, type: string): void {
  act(() => { node.dispatchEvent(new (viewOf(node).Event)(type)); });
}

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

describe("complete-terminal compose input", () => {
  test("expanding the pad and submitting settled text preserve the focused textarea", () => {
    setKeysExpanded(false);
    setComposeDraft("draft");
    const sent: string[] = [];
    const root = render((text) => { sent.push(text); return true; });
    const input = root.querySelector("textarea")!;
    act(() => { input.focus(); });
    input.setSelectionRange(1, 3);
    const more = root.querySelector<HTMLButtonElement>(".key-more")!;
    const down = new PointerEvent("pointerdown", { button: 0, cancelable: true });
    more.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    act(() => { more.click(); });
    expect(root.querySelector("textarea") === input).toBeTrue();
    expect(document.activeElement === input).toBeTrue();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
    const enter = root.querySelector<HTMLButtonElement>('[aria-label="Enter"]')!;
    act(() => { enter.click(); });
    expect(sent).toEqual(["draft"]);
    expect(document.activeElement === input).toBeTrue();
    const send = root.querySelector<HTMLButtonElement>(".full-terminal-compose-send")!;
    const sendDown = new PointerEvent("pointerdown", { button: 0, cancelable: true });
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

  test("keeps local IME text until the terminal accepts it", () => {
    setComposeDraft("待发送");
    const attempts: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      attempts.push([text, enter]);
      return attempts.length > 1;
    });
    const form = root.querySelector(".full-terminal-compose-form") as HTMLFormElement;
    const input = root.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement;
    expect(input.value).toBe("待发送");
    act(() => { form.requestSubmit(); });
    expect(composeDraft()).toBe("待发送");
    act(() => { form.requestSubmit(); });
    expect(attempts).toEqual([["待发送", true], ["待发送", true]]);
    expect(composeDraft()).toBe("");
    expect(input.value).toBe("");
  });

  test("does not submit unfinished composition or Shift+Enter", () => {
    const sent: string[] = [];
    const root = render((text) => {
      sent.push(text);
      return true;
    });
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "拼音";
    fire(input, "compositionstart");
    dispatchKey(input, "keydown", { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    fire(input, "compositionend");
    dispatchKey(input, "keydown", { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    dispatchKey(input, "keydown", { key: "Enter" });
    expect(sent).toEqual(["拼音"]);
  });

  test("submits Chromium-style composing Enter exactly once after compositionend", async () => {
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    const form = root.querySelector("form") as HTMLFormElement;
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    fire(input, "compositionstart");
    input.value = "中文";
    fire(input, "input");
    dispatchKey(input, "keydown", { key: "Enter", isComposing: true }, 229);
    expect(sent).toEqual([]);
    fire(input, "compositionend");
    input.value = "中文完成";
    fire(input, "input");
    dispatchKey(input, "keydown", { key: "Enter", repeat: true });
    act(() => { form.requestSubmit(); });
    dispatchKey(input, "keyup", { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(sent).toEqual([["中文完成", true]]);
    expect(input.value).toBe("");
    expect(composeDraft()).toBe("");
  });

  test("submits WebKit-style Enter when compositionend precedes keydown", () => {
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    const form = root.querySelector("form") as HTMLFormElement;
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    fire(input, "compositionstart");
    input.value = "候选词";
    fire(input, "input");
    fire(input, "compositionend");
    dispatchKey(input, "keydown", { key: "Enter" }, 229);
    dispatchKey(input, "keydown", { key: "Enter", repeat: true }, 229);
    act(() => { form.requestSubmit(); });
    dispatchKey(input, "keyup", { key: "Enter" });
    expect(sent).toEqual([["候选词", true]]);
  });

  test("preserves an IME draft when delivery is not ready and retries only on a new Enter", async () => {
    const attempts: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      attempts.push([text, enter]);
      return attempts.length > 1;
    });
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    fire(input, "compositionstart");
    input.value = "暂存中文";
    fire(input, "input");
    dispatchKey(input, "keydown", { key: "Enter", isComposing: true }, 229);
    fire(input, "compositionend");
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

  test("expanded pad Enter submits the draft in compose mode", () => {
    setKeysExpanded(true);
    setComposeDraft("confirm");
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    act(() => { (root.querySelector('[aria-label="Enter"]') as HTMLButtonElement).click(); });
    expect(sent).toEqual([["confirm", true]]);
  });

  test("expanded pad Enter completes an IME even when blur emits no compositionend", async () => {
    setKeysExpanded(true);
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    act(() => { input.focus(); });
    fire(input, "compositionstart");
    input.value = "屏幕回车";
    fire(input, "input");

    await act(async () => {
      (root.querySelector('[aria-label="Enter"]') as HTMLButtonElement).click();
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

  test("expanded command chips fill compose mode and stream in live mode", () => {
    setKeysExpanded(false);
    setPadKind("keys");
    const sent: Array<[string, boolean]> = [];
    const options = {
      sendKey: () => undefined,
      sendCompose: (text: string, enter: boolean) => {
        sent.push([text, enter]);
        return true;
      },
      keyboard: keyboard(),
      desk: false,
    };
    renderReact(createElement(FullTerminalPad, { options }));
    const root = appRoot();
    act(() => { (root.querySelector('[aria-label="更多按键"]') as HTMLButtonElement).click(); });
    expect(root.querySelector(".full-terminal-compose-input") !== null).toBeTrue();
    const commandMode = [...root.querySelectorAll<HTMLButtonElement>(".pad-mode button")]
      .find((el) => el.textContent === "命令");
    act(() => { commandMode?.click(); });
    expect(root.querySelector(".full-terminal-compose-input") !== null).toBeTrue();
    act(() => { (root.querySelector('[aria-label="插入 /goal，接着填目标"]') as HTMLButtonElement).click(); });
    expect(composeDraft()).toBe("/goal ");
    expect((root.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe("/goal ");
    expect(sent).toEqual([]);

    act(() => { setComposeLive(true); });
    renderReact(createElement(FullTerminalPad, { options }));
    act(() => { (root.querySelector('[aria-label="插入 /clear"]') as HTMLButtonElement).click(); });
    expect(sent).toEqual([["/clear", false]]);
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