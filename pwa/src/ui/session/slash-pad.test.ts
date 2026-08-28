import { describe, expect, test } from "bun:test";

const dock = await Bun.file(new URL("./dock.ts", import.meta.url)).text();
const pad = await Bun.file(new URL("./slash-pad.ts", import.meta.url)).text();
const compose = await Bun.file(new URL("./compose.ts", import.meta.url)).text();

describe("expanded pad modes", () => {
  test("the switcher only appears once the pad is expanded", () => {
    expect(dock).toContain("if (state.keysExpanded)");
    expect(dock).toContain("padModeBar()");
    expect(dock).toContain('state.padKind === "slash"');
    expect(dock).toContain("slashPad()");
    expect(dock.indexOf("padModeBar()")).toBeGreaterThan(dock.indexOf("if (state.keysExpanded)"));
  });

  test("slash chips fill compose instead of sending keys", () => {
    expect(pad).toContain("setComposeText(command.token)");
    expect(pad).not.toContain("queueKey");
    expect(pad).not.toContain("sendPad");
    expect(compose).toContain("export function setComposeText");
  });

  test("switching morphs the expanded body and drops latched modifiers", () => {
    expect(pad).toContain('label: "按键"');
    expect(pad).toContain('label: "命令"');
    expect(pad).toContain("clearModifiers()");
    expect(pad).toContain("savePadKind()");
  });
});
