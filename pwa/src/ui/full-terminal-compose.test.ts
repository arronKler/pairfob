import { Window } from "happy-dom";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLTextAreaElement",
  "Event",
  "KeyboardEvent",
  "Node",
  "localStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { state } = await import("../state.ts");
const {
  setFullTerminalInputMode,
  submitFullTerminalCompose,
  syncFullTerminalControls,
} = await import("./full-terminal-compose.ts");

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
  const root = document.createElement("div");
  syncFullTerminalControls(root, {
    sendKey: () => undefined,
    sendCompose,
    keyboard: keyboard(),
    desk: false,
  });
  return root;
}

function dispatchKey(
  input: HTMLTextAreaElement,
  type: "keydown" | "keyup",
  init: KeyboardEventInit,
  keyCode?: number,
): void {
  const event = new KeyboardEvent(type, { bubbles: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  input.dispatchEvent(event);
}

beforeAll(() => {
  state.paneId = "p1";
});

afterEach(() => {
  state.composeDraft = "";
  state.composeFocused = false;
  state.composeIME = false;
  state.composeLive = false;
  state.keysExpanded = false;
  state.padKind = "keys";
  state.paneComposeLive = {};
  localStorage.clear();
});

describe("complete-terminal compose input", () => {
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
    state.composeDraft = "待发送";
    const attempts: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      attempts.push([text, enter]);
      return attempts.length > 1;
    });
    const form = root.querySelector(".full-terminal-compose-form") as HTMLFormElement;
    const input = root.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement;
    expect(input.value).toBe("待发送");
    form.requestSubmit();
    expect(state.composeDraft).toBe("待发送");
    form.requestSubmit();
    expect(attempts).toEqual([["待发送", true], ["待发送", true]]);
    expect(state.composeDraft).toBe("");
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
    input.dispatchEvent(new Event("compositionstart"));
    dispatchKey(input, "keydown", { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    input.dispatchEvent(new Event("compositionend"));
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
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "中文";
    input.dispatchEvent(new Event("input"));
    dispatchKey(input, "keydown", { key: "Enter", isComposing: true }, 229);
    expect(sent).toEqual([]);
    input.dispatchEvent(new Event("compositionend"));
    // Firefox can publish the committed value in an input event after
    // compositionend. The queued submit must observe that value as well.
    input.value = "中文完成";
    input.dispatchEvent(new Event("input"));
    dispatchKey(input, "keydown", { key: "Enter", repeat: true });
    form.requestSubmit();
    dispatchKey(input, "keyup", { key: "Enter" });
    await Promise.resolve();
    expect(sent).toEqual([["中文完成", true]]);
    expect(input.value).toBe("");
    expect(state.composeDraft).toBe("");
  });

  test("submits WebKit-style Enter when compositionend precedes keydown", () => {
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    const form = root.querySelector("form") as HTMLFormElement;
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "候选词";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("compositionend"));
    dispatchKey(input, "keydown", { key: "Enter" }, 229);
    dispatchKey(input, "keydown", { key: "Enter", repeat: true }, 229);
    form.requestSubmit();
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
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "暂存中文";
    input.dispatchEvent(new Event("input"));
    dispatchKey(input, "keydown", { key: "Enter", isComposing: true }, 229);
    input.dispatchEvent(new Event("compositionend"));
    dispatchKey(input, "keyup", { key: "Enter" });
    await Promise.resolve();
    expect(attempts).toEqual([["暂存中文", true]]);
    expect(input.value).toBe("暂存中文");
    expect(state.composeDraft).toBe("暂存中文");

    dispatchKey(input, "keydown", { key: "Enter" });
    dispatchKey(input, "keyup", { key: "Enter" });
    expect(attempts).toEqual([
      ["暂存中文", true],
      ["暂存中文", true],
    ]);
    expect(input.value).toBe("");
  });

  test("expanded pad Enter submits the draft in compose mode", () => {
    state.keysExpanded = true;
    state.composeDraft = "confirm";
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    (root.querySelector('[aria-label="Enter"]') as HTMLButtonElement).click();
    expect(sent).toEqual([["confirm", true]]);
  });

  test("expanded pad Enter completes an IME even when blur emits no compositionend", async () => {
    state.keysExpanded = true;
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    input.focus();
    input.dispatchEvent(new Event("compositionstart"));
    input.value = "屏幕回车";
    input.dispatchEvent(new Event("input"));

    (root.querySelector('[aria-label="Enter"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toEqual([["屏幕回车", true]]);
    expect(input.value).toBe("");
    expect(state.composeIME).toBeFalse();
  });

  test("expanded command chips fill compose mode and stream in live mode", () => {
    state.keysExpanded = false;
    state.padKind = "keys";
    const sent: Array<[string, boolean]> = [];
    const root = render((text, enter) => {
      sent.push([text, enter]);
      return true;
    });
    (root.querySelector('[aria-label="更多按键"]') as HTMLButtonElement).click();
    expect(root.querySelector(".full-terminal-compose-input")).toBeTruthy();
    const commandMode = [...root.querySelectorAll<HTMLButtonElement>(".pad-mode button")]
      .find((el) => el.textContent === "命令");
    commandMode?.click();
    expect(root.querySelector(".full-terminal-compose-input")).toBeTruthy();
    (root.querySelector('[aria-label="插入 /goal，接着填目标"]') as HTMLButtonElement).click();
    expect(state.composeDraft).toBe("/goal ");
    expect((root.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe("/goal ");
    expect(sent).toEqual([]);

    state.composeLive = true;
    syncFullTerminalControls(root, {
      sendKey: () => undefined,
      sendCompose: (text, enter) => {
        sent.push([text, enter]);
        return true;
      },
      keyboard: keyboard(),
      desk: false,
    });
    (root.querySelector('[aria-label="插入 /clear"]') as HTMLButtonElement).click();
    expect(sent).toEqual([["/clear", false]]);
  });

  test("switching modes persists the pane choice and preserves rejected drafts", () => {
    state.composeDraft = "not connected";
    let repaints = 0;
    setFullTerminalInputMode(true, () => false, () => { repaints++; });
    expect(state.composeLive).toBe(true);
    expect(state.composeDraft).toBe("not connected");
    expect(state.paneComposeLive.p1).toBe(true);
    expect(repaints).toBe(1);
    setFullTerminalInputMode(false, () => true, () => { repaints++; });
    expect(state.composeLive).toBe(false);
    expect(state.composeDraft).toBe("not connected");
    expect(state.paneComposeLive.p1).toBe(false);
  });
});
