import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { keysExpanded, padKind, setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { composeDraft, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from "../compose-store";
const { SLASH_COMMANDS } = await import("../../../lib/slash-commands");
const { notifyFullTerminalKeyboard } = await import("./full-terminal-input");
const { clearModifiers } = await import("../keypad/keypad");
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

// Isolated single-component boundary via the shared harness: renderReact mounts
// one FullTerminalPad in its own root; unmountReact releases it. Never the App.
function paint(sendKey: (key: string) => void = () => undefined, sendCompose: (text: string, enter: boolean) => boolean = () => true, desk = false) {
  const options = { sendKey, sendCompose, keyboard: keyboard(), desk };
  renderReact(createElement(FullTerminalPad, { options }));
  return options;
}

beforeEach(async () => { await resetBoardTestDOM(); });

afterEach(async () => {
  unmountReact();
  await act(async () => {
    notifyFullTerminalKeyboard(false);
    clearModifiers();
    setComposeDraft("");
    setComposeFocused(false);
    setComposeIME(false);
    setComposeLive(false);
    setKeysExpanded(false);
    setPadKind("keys");
  });
});

describe("React full-terminal pad", () => {
  test("does not use guided queueKey and routes pad keys through sendKey", async () => {
    expect(padSource).not.toMatch(/\bqueueKey\b/);
    expect(padSource).toContain("withModifiers");
    expect(padSource).toContain("optionsRef.current.sendKey");
    const sent: string[] = [];
    await act(() => { paint((key) => sent.push(key)); });
    const up = appRoot().querySelector('[aria-label="上箭头"]') as HTMLButtonElement;
    const view = appRoot().ownerDocument.defaultView!;
    await act(() => { up.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })); });
    expect(sent).toEqual(["up"]);
  });

  test("shows esc and arrows, then more keys after expand, without remounting compose", async () => {
    setKeysExpanded(false);
    setComposeDraft("draft");
    await act(() => { paint(); });
    const input = appRoot().querySelector("textarea")!;
    await act(() => {
      input.focus();
      input.setSelectionRange(1, 3);
    });
    const labels = [...appRoot().querySelectorAll("button")].map((el) => el.textContent);
    expect(labels.slice(0, 6)).toEqual(["Esc", "↑", "↓", "←", "→", "⌫"]);
    const more = appRoot().querySelector<HTMLButtonElement>(".key-more")!;
    const view = appRoot().ownerDocument.defaultView!;
    const down = new view.PointerEvent("pointerdown", { button: 0, cancelable: true });
    await act(() => { more.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    await act(() => { more.click(); });
    expect(keysExpanded()).toBe(true);
    expect(appRoot().querySelector("textarea") === input).toBeTrue();
    expect(document.activeElement === input).toBeTrue();
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
    expect(appRoot().textContent).toContain("Ctrl+C");
    expect(appRoot().textContent).toContain("Opt");
    expect(appRoot().querySelector(".pad-mode")?.getAttribute("aria-label")).toBe("扩展键盘形态");
  });

  test("expanded commands fill compose in batch and send text without Enter in live", async () => {
    act(() => { setKeysExpanded(true); setPadKind("keys"); });
    const sent: Array<[string, boolean]> = [];
    const options = { sendKey: () => undefined, sendCompose: (text: string, enter: boolean) => { sent.push([text, enter]); return true; }, keyboard: keyboard(), desk: false };
    renderReact(createElement(FullTerminalPad, { options }));
    const commandMode = [...appRoot().querySelectorAll<HTMLButtonElement>(".pad-mode button")]
      .find((el) => el.textContent === "命令")!;
    await act(() => { commandMode.click(); });
    expect(padKind()).toBe("slash");
    expect(appRoot().querySelector('[aria-checked="true"]')?.textContent).toBe("命令");
    expect([...appRoot().querySelectorAll(".slash-cmd")].map((el) => el.textContent)).toEqual(SLASH_COMMANDS.map((c) => c.label));
    await act(() => { (appRoot().querySelector('[aria-label="插入 /goal，接着填目标"]') as HTMLButtonElement).click(); });
    expect(composeDraft()).toBe("/goal ");
    expect((appRoot().querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe("/goal ");
    expect(sent).toEqual([]);

    act(() => { setComposeLive(true); });
    renderReact(createElement(FullTerminalPad, { options }));
    await act(() => { (appRoot().querySelector('[aria-label="插入 /clear"]') as HTMLButtonElement).click(); });
    expect(sent).toEqual([["/clear", false]]);
  });

  test("live keyboard is a named control and updates from notifyFullTerminalKeyboard", async () => {
    act(() => { setComposeLive(true); });
    const kb = keyboard();
    const options = { sendKey: () => undefined, sendCompose: () => true, keyboard: kb, desk: false };
    renderReact(createElement(FullTerminalPad, { options }));
    const button = appRoot().querySelector(".full-terminal-kb") as HTMLButtonElement;
    expect(button.textContent).toBe("点这里输入");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    const view = appRoot().ownerDocument.defaultView!;
    await act(() => {
      button.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(kb.isOpen()).toBe(true);
    expect(button.textContent).toBe("收起键盘");
    await act(() => { kb.close(); notifyFullTerminalKeyboard(false); });
    expect(button.textContent).toBe("点这里输入");
    expect((appRoot().querySelector(".full-terminal-compose-form")) === null).toBeTrue();
  });

  test("unmount destroys pad press so a detached key cannot stay pressed", async () => {
    await act(() => { paint(); });
    const esc = [...appRoot().querySelectorAll("button")].find((el) => el.textContent === "Esc") as HTMLButtonElement;
    const view = appRoot().ownerDocument.defaultView!;
    unmountReact();
    esc.dispatchEvent(new view.PointerEvent("pointerdown", { button: 0, cancelable: true }));
    expect(esc.classList.contains("is-pressed")).toBe(false);
  });
});
