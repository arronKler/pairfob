import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "HTMLButtonElement", "Node", "localStorage"] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { state } = await import("../../state.ts");
const { keyPad } = await import("./dock.ts");
const { SLASH_COMMANDS } = await import("../../lib/slash-commands.ts");

describe("session pad morphs", () => {
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
