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

  test("does not submit an unfinished composition or Shift+Enter", () => {
    const sent: string[] = [];
    const root = render((text) => {
      sent.push(text);
      return true;
    });
    const input = root.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "拼音";
    input.dispatchEvent(new Event("compositionstart"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toEqual([]);
    input.dispatchEvent(new Event("compositionend"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(sent).toEqual([]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toEqual(["拼音"]);
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
