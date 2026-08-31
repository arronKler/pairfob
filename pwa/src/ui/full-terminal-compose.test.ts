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
  state.paneComposeLive = {};
  localStorage.clear();
});

describe("complete-terminal compose input", () => {
  test("encodes one composed submission with its trailing Enter", () => {
    const sent: Uint8Array[] = [];
    expect(submitFullTerminalCompose("中文", true, true, (data) => sent.push(data))).toBe(true);
    expect(new TextDecoder().decode(sent[0])).toBe("中文\r");
    expect(submitFullTerminalCompose("later", false, false, (data) => sent.push(data))).toBe(false);
    expect(sent).toHaveLength(1);
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
