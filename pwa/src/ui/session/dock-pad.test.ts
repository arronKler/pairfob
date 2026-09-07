import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "HTMLButtonElement", "Node", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { state } = await import("../../state.ts");
const { keyPad, dockNode } = await import("./dock.ts");
const { setRenderer } = await import("../../paint.ts");
const { SLASH_COMMANDS } = await import("../../lib/slash-commands.ts");

describe("session pad morphs", () => {
  test("expanding and switching pad modes preserves the same focused IME field and selection", () => {
    state.keysExpanded = false;
    state.padKind = "keys";
    const { dock, input } = dockNode(true);
    document.body.append(dock);
    let repaints = 0;
    setRenderer(() => { repaints++; });
    try {
      input.value = "正在编辑的文字";
      input.focus();
      input.setSelectionRange(1, 4);
      input.dispatchEvent(new happy.Event("compositionstart"));
      const tap = (button: HTMLButtonElement) => {
        const down = new happy.PointerEvent("pointerdown", { button: 0, cancelable: true });
        button.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        button.click();
        expect(dock.querySelector("textarea")).toBe(input);
        expect(document.activeElement).toBe(input);
        expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
        expect(input.value).toBe("正在编辑的文字");
        expect(state.composeIME).toBe(true);
      };
      tap(dock.querySelector(".key-more")!);
      expect(state.keysExpanded).toBe(true);
      tap(dock.querySelectorAll<HTMLButtonElement>(".pad-mode button")[1]);
      expect(dock.querySelector(".slash-pad")).toBeTruthy();
      tap(dock.querySelectorAll<HTMLButtonElement>(".pad-mode button")[0]);
      expect(dock.querySelector(".key-mod")).toBeTruthy();
      tap(dock.querySelector(".key-more")!);
      expect(state.keysExpanded).toBe(false);
      expect(repaints).toBe(0);
    } finally {
      dock.remove();
      state.composeIME = false;
      state.composeFocused = false;
      setRenderer(() => undefined);
    }
  });

  test("collapsed pad keeps only the TUI survival row", () => {
    state.keysExpanded = false;
    const pad = keyPad();
    expect(pad.querySelector(".pad-mode")).toBeNull();
    expect(pad.querySelector(".slash-pad")).toBeNull();
    expect(pad.querySelector('[aria-label="终端快捷键"]')).toBeTruthy();
  });

  test("expanded keys still expose Tab, Enter and modifiers", () => {
    state.keysExpanded = true;
    state.padKind = "keys";
    const pad = keyPad();
    expect(pad.querySelector(".pad-mode")?.getAttribute("aria-label")).toBe("扩展键盘形态");
    expect(pad.querySelector(".slash-pad")).toBeNull();
    expect(pad.textContent).toContain("Tab");
    expect(pad.textContent).toContain("Ctrl");
    expect(pad.textContent).toContain("换行");
  });

  test("expanded command morph fills compose chips and not SendKeys", () => {
    state.keysExpanded = true;
    state.padKind = "slash";
    const pad = keyPad();
    const chips = [...pad.querySelectorAll(".slash-cmd")].map((el) => el.textContent);
    expect(chips).toEqual(SLASH_COMMANDS.map((command) => command.label));
    expect(pad.textContent).not.toContain("Tab");
    expect(pad.querySelector('[aria-checked="true"]')?.textContent).toBe("命令");
  });
});
