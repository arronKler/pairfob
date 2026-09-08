import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "./root";
const { app, state } = await import("../../state");
const { SLASH_COMMANDS } = await import("../../lib/slash-commands");
const { notifyFullTerminalKeyboard } = await import("../full-terminal-input");
const { clearModifiers } = await import("../keypad");
const { FullTerminalPad } = await import("./full-terminal-pad");
const padSource = await Bun.file(new URL("./full-terminal-pad.tsx", import.meta.url)).text();

function keyboard() {
  let open = false;
  return {
    toggle: () => { open = !open; },
    open: () => { open = true; },
    close: () => { open = false; },
    isOpen: () => open,
  };
}

function paint(sendKey: (key: string) => void = () => undefined, sendCompose: (text: string, enter: boolean) => boolean = () => true, desk = false) {
  const options = { sendKey, sendCompose, keyboard: keyboard(), desk };
  renderReactScreen(<FullTerminalPad options={options} />);
  return options;
}

beforeEach(async () => { await resetBoardTestDOM(); });

afterEach(async () => {
  await act(() => leaveReactScreen());
  notifyFullTerminalKeyboard(false);
  clearModifiers();
  state.composeDraft = "";
  state.composeFocused = false;
  state.composeIME = false;
  state.composeLive = false;
  state.keysExpanded = false;
  state.padKind = "keys";
  state.paneComposeLive = {};
  app.replaceChildren();
});

describe("React full-terminal pad", () => {
  test("does not use guided queueKey and routes pad keys through sendKey", async () => {
    expect(padSource).not.toMatch(/\bqueueKey\b/);
    expect(padSource).toContain("withModifiers");
    expect(padSource).toContain("optionsRef.current.sendKey");
    const sent: string[] = [];
    await act(() => { paint((key) => sent.push(key)); });
    const up = app.querySelector('[aria-label="上箭头"]') as HTMLButtonElement;
    const view = app.ownerDocument.defaultView!;
    up.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    expect(sent).toEqual(["up"]);
  });

  test("shows esc and arrows, then more keys after expand, without remounting compose", async () => {
    state.keysExpanded = false;
    state.composeDraft = "draft";
    await act(() => { paint(); });
    const input = app.querySelector("textarea")!;
    input.focus();
    input.setSelectionRange(1, 3);
    const labels = [...app.querySelectorAll("button")].map((el) => el.textContent);
    expect(labels.slice(0, 6)).toEqual(["Esc", "↑", "↓", "←", "→", "⌫"]);
    const more = app.querySelector<HTMLButtonElement>(".key-more")!;
    const view = app.ownerDocument.defaultView!;
    const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
    more.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await act(() => { more.click(); });
    expect(state.keysExpanded).toBe(true);
    expect(app.querySelector("textarea") === input).toBeTrue();
    expect(document.activeElement === input).toBeTrue();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
    expect(app.textContent).toContain("Ctrl+C");
    expect(app.textContent).toContain("Opt");
    expect(app.querySelector(".pad-mode")?.getAttribute("aria-label")).toBe("扩展键盘形态");
  });

  test("expanded commands fill compose in batch and send text without Enter in live", async () => {
    state.keysExpanded = true;
    state.padKind = "keys";
    const sent: Array<[string, boolean]> = [];
    const options = { sendKey: () => undefined, sendCompose: (text: string, enter: boolean) => { sent.push([text, enter]); return true; }, keyboard: keyboard(), desk: false };
    await act(() => { renderReactScreen(<FullTerminalPad options={options} />); });
    const commandMode = [...app.querySelectorAll<HTMLButtonElement>(".pad-mode button")]
      .find((el) => el.textContent === "命令")!;
    await act(() => { commandMode.click(); });
    expect(state.padKind).toBe("slash");
    expect(app.querySelector('[aria-checked="true"]')?.textContent).toBe("命令");
    expect([...app.querySelectorAll(".slash-cmd")].map((el) => el.textContent)).toEqual(SLASH_COMMANDS.map((c) => c.label));
    await act(() => { (app.querySelector('[aria-label="插入 /goal，接着填目标"]') as HTMLButtonElement).click(); });
    expect(state.composeDraft).toBe("/goal ");
    expect((app.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe("/goal ");
    expect(sent).toEqual([]);

    state.composeLive = true;
    await act(() => { renderReactScreen(<FullTerminalPad options={options} />); });
    await act(() => { (app.querySelector('[aria-label="插入 /clear"]') as HTMLButtonElement).click(); });
    expect(sent).toEqual([["/clear", false]]);
  });

  test("live keyboard is a named control and updates from notifyFullTerminalKeyboard", async () => {
    state.composeLive = true;
    const kb = keyboard();
    const options = { sendKey: () => undefined, sendCompose: () => true, keyboard: kb, desk: false };
    await act(() => { renderReactScreen(<FullTerminalPad options={options} />); });
    const button = app.querySelector(".full-terminal-kb") as HTMLButtonElement;
    expect(button.textContent).toBe("点这里输入");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    const view = app.ownerDocument.defaultView!;
    await act(() => {
      button.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(kb.isOpen()).toBe(true);
    expect(button.textContent).toBe("收起键盘");
    kb.close();
    await act(() => { notifyFullTerminalKeyboard(false); });
    expect(button.textContent).toBe("点这里输入");
    expect((app.querySelector(".full-terminal-compose-form")) === null).toBeTrue();
  });

  test("unmount destroys pad press so a detached key cannot stay pressed", async () => {
    await act(() => { paint(); });
    const esc = [...app.querySelectorAll("button")].find((el) => el.textContent === "Esc") as HTMLButtonElement;
    const view = app.ownerDocument.defaultView!;
    await act(() => leaveReactScreen());
    esc.dispatchEvent(new view.PointerEvent("pointerdown", { button: 0, cancelable: true }));
    expect(esc.classList.contains("is-pressed")).toBe(false);
  });
});
