import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "KeyboardEvent",
  "Node",
  "localStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../../state.ts");
const { composeForm, handlePaneKey, sendPad, submitTyped } = await import("./compose.ts");
const { dropQueuedKeys, flushKeys } = await import("./keys.ts");

function mount(draft: string, live = false): HTMLButtonElement {
  state.composeDraft = draft;
  state.composeLive = live;
  const { form } = composeForm(false);
  app.replaceChildren(form);
  const button = form.querySelector(".send-btn");
  if (!(button instanceof HTMLButtonElement)) throw new Error("missing compose Enter");
  return button;
}

afterEach(() => {
  dropQueuedKeys();
  state.composeDraft = "";
  state.composeLive = false;
  state.live = null;
  state.paneId = "";
  state.paneText = "";
  state.screen = "home";
  app.replaceChildren();
});

describe("compose trailing Enter safety", () => {
  test("unknown prompts cannot enable an empty under-thumb Enter", () => {
    state.paneText = "Delete everything? [Y/n]";
    const button = mount("");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toContain("裸回车请用系统键盘或按键垫");

    state.paneText = "1. Keep\n3. Delete";
    expect(mount("").disabled).toBe(true);
    expect(mount("run tests").disabled).toBe(false);
  });

  test("live mode does not turn the trailing button into an empty mutation", () => {
    const button = mount("", true);
    expect(button.textContent).toBe("Enter");
    expect(button.disabled).toBe(true);
  });

  test("a deliberate keyboard Enter remains available outside the trailing button", async () => {
    const sent: string[][] = [];
    state.paneId = "p1";
    state.screen = "home";
    state.live = {
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as typeof state.live;
    mount("");

    const event = new happy.KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    handlePaneKey(event, true);
    await flushKeys();

    expect(event.defaultPrevented).toBe(true);
    expect(sent).toEqual([["enter"]]);
  });

  test("programmatic form submit cannot become bare Enter, but keypad Enter can", async () => {
    const sent: string[][] = [];
    state.paneId = "p1";
    state.live = {
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as typeof state.live;
    mount("");

    await submitTyped();
    await flushKeys();
    expect(sent).toEqual([]);

    await sendPad("enter");
    await flushKeys();
    expect(sent).toEqual([["enter"]]);
  });
});
