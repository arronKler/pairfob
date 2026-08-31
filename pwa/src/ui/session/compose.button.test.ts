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

const { app, paneComposeLive, setPaneComposeLive, state } = await import("../../state.ts");
const { t } = await import("../../lib/i18n.ts");
const { composeForm, flushLiveInput, handlePaneKey, sendPad, setComposeLive, submitTyped } = await import("./compose.ts");
const { disposeFullTerminal } = await import("../full-terminal.ts");
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
  disposeFullTerminal();
  dropQueuedKeys();
  state.composeDraft = "";
  state.composeLive = false;
  state.defaultComposeLive = false;
  state.paneComposeLive = {};
  state.live = null;
  state.paneId = "";
  state.paneText = "";
  state.screen = "home";
  app.replaceChildren();
});

describe("compose trailing Enter", () => {
  const lifted = [
    "╭──────────────────────────────────────────────────╮",
    "│ Edit file                                        │",
    "│                                                  │",
    "│ Do you want to make this edit to config.ts?      │",
    "│ ❯ 1. Yes                                         │",
    "│   2. Yes, allow all edits this session           │",
    "│   3. No, and tell Claude what to do differently  │",
    "╰──────────────────────────────────────────────────╯",
    "",
    "  esc to interrupt · ? for shortcuts",
  ].join("\n");

  test("empty Enter stays available on ordinary and confirmation screens", () => {
    state.paneText = "Delete everything? [Y/n]";
    const open = mount("");
    expect(open.disabled).toBe(false);
    expect(open.textContent).toBe("Enter");
    expect(open.getAttribute("aria-label")).toBe("向终端发送 Enter");

    state.paneText = lifted;
    const prompt = mount("");
    expect(prompt.disabled).toBe(false);
    expect(prompt.getAttribute("aria-label")).toBe("向终端发送 Enter");
    expect(mount("run tests").disabled).toBe(false);
  });

  test("live mode keeps an empty trailing Enter", () => {
    const button = mount("", true);
    expect(button.textContent).toBe("Enter");
    expect(button.disabled).toBe(false);
  });

  test("selecting live input stays in the guided view and belongs only to the active pane", async () => {
    state.paneId = "p1";
    state.screen = "pane";
    state.live = { isConnected: () => true } as typeof state.live;
    mount("");

    await setComposeLive(true);

    expect(state.composeLive).toBeTrue();
    expect(state.fullTerminal).toBeFalse();
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
  });

  test("a delayed mode flush cannot overwrite the next pane's input mode", async () => {
    let finishSend!: () => void;
    state.paneId = "p1";
    state.screen = "pane";
    state.live = {
      isConnected: () => true,
      sendText: () => new Promise<void>((resolve) => { finishSend = resolve; }),
    } as typeof state.live;
    mount("", true);
    const input = app.querySelector("textarea");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing live compose");
    input.value = "one";
    input.dispatchEvent(new happy.Event("input", { bubbles: true }));

    const changing = setComposeLive(false);
    await Promise.resolve();
    state.paneId = "p2";
    state.composeLive = true;
    setPaneComposeLive("p2", true);
    finishSend();
    await changing;

    expect(state.composeLive).toBeTrue();
    expect(paneComposeLive("p1")).toBeFalse();
    expect(paneComposeLive("p2")).toBeTrue();
  });

  test("live input is visible locally before the network flush", async () => {
    const sent: string[] = [];
    state.paneId = "p1";
    state.screen = "home";
    state.live = {
      isConnected: () => true,
      sendText: async (_paneId: string, text: string) => {
        sent.push(text);
      },
    } as typeof state.live;
    mount("", true);
    const input = app.querySelector("textarea");
    const form = app.querySelector(".dock-form");
    if (!(input instanceof HTMLTextAreaElement) || !(form instanceof HTMLElement)) throw new Error("missing live compose");

    input.value = "hello";
    input.dispatchEvent(new happy.Event("input", { bubbles: true }));

    expect(input.value).toBe("");
    expect(input.placeholder).toBe("本机待回显 · hello");
    expect(form.classList.contains("live-pending")).toBeTrue();
    expect(form.querySelector(".live-input-status")?.textContent).toBe(t("compose.pendingStatus", { n: 5 }));
    expect(sent).toEqual([]);

    expect(await flushLiveInput()).toBeTrue();
    expect(sent).toEqual(["hello"]);
    expect(input.placeholder).toBe("实时 · 边打边进终端");
  });

  test("a failed live mutation pauses live mode and restores text for deliberate retry", async () => {
    state.paneId = "p1";
    state.screen = "home";
    state.live = {
      isConnected: () => true,
      sendText: async () => { throw new Error("not sent"); },
    } as typeof state.live;
    mount("", true);
    const input = app.querySelector("textarea");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing live compose");
    input.value = "retry me";
    input.dispatchEvent(new happy.Event("input", { bubbles: true }));

    expect(await flushLiveInput()).toBeFalse();
    expect(state.composeLive).toBeFalse();
    expect(state.composeDraft).toBe("retry me");
    expect(input.value).toBe("retry me");
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

  test("the trailing button and keypad both send a bare Enter", async () => {
    const sent: string[][] = [];
    state.paneId = "p1";
    state.live = {
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as typeof state.live;
    const button = mount("");

    await submitTyped(true);
    await flushKeys();
    expect(sent).toEqual([["enter"]]);

    sent.length = 0;
    button.click();
    await flushKeys();
    expect(sent).toEqual([["enter"]]);

    sent.length = 0;
    await sendPad("enter");
    await flushKeys();
    expect(sent).toEqual([["enter"]]);
  });

  test("a confirmation screen receives the same deliberate Enter as any TUI", async () => {
    const sent: string[][] = [];
    state.paneId = "p1";
    state.paneText = lifted;
    state.live = {
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as typeof state.live;
    mount("");

    await submitTyped(true);
    await flushKeys();
    expect(sent).toEqual([["enter"]]);
  });
});
