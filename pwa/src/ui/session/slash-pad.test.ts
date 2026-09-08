import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { leaveReactScreen, renderReactScreen } from "../react/root";

const { setLang } = await import("../../lib/i18n");
const { setRenderer } = await import("../../paint");
const { app, clearNotice, state } = await import("../../state.ts");
const { clearModifiers, pressModifier, withModifiers } = await import("../keypad.ts");
const { selectPadKind } = await import("./slash-pad.ts");
const { SessionKeyPad, SessionSlashPad } = await import("../react/session-dock.tsx");
const pad = await Bun.file(new URL("./slash-pad.ts", import.meta.url)).text();
const keypad = await Bun.file(new URL("../react/session-keypad.tsx", import.meta.url)).text();
const compose = await Bun.file(new URL("./compose.ts", import.meta.url)).text();
const slashView = await Bun.file(new URL("../react/session-slash-pad.tsx", import.meta.url)).text();

beforeEach(async () => {
  await resetBoardTestDOM();
  act(leaveReactScreen);
  app.replaceChildren();
  setLang("zh");
  setRenderer(() => {});
  Object.assign(state, {
    phase: "live", screen: "home", paneId: "", paneText: "", paneHash: "", live: null,
    agents: [], fullTerminal: false, agentChat: false, operationBusy: false,
    composeDraft: "", composeLive: false, composeIME: false, composeFocused: false,
    defaultComposeLive: false, paneComposeLive: {}, keysExpanded: false, padKind: "keys",
    termSelect: false, termWrap: false, paneRow: null, paneFollow: true, paneUnread: false,
  });
  clearNotice();
});

afterEach(async () => {
  await act(() => leaveReactScreen());
  clearModifiers();
  state.keysExpanded = false;
  state.padKind = "keys";
  clearNotice();
  setRenderer(() => {});
  app.replaceChildren();
});

describe("expanded pad modes", () => {
  test("the switcher only appears once the pad is expanded", async () => {
    state.keysExpanded = false;
    await act(() => { renderReactScreen(createElement(SessionKeyPad)); });
    expect(app.querySelector(".pad-mode")).toBeNull();
    expect(app.querySelector(".slash-pad")).toBeNull();
    state.keysExpanded = true;
    await act(() => { renderReactScreen(createElement(SessionKeyPad)); });
    expect(app.querySelector(".pad-mode")).toBeTruthy();
    expect(keypad).toContain("const expanded = state.keysExpanded");
    expect(keypad).toContain("{expanded && <SessionPadModeBar onRepaint={repaint} />}");
    expect(keypad.indexOf("{expanded && <SessionPadModeBar")).toBeGreaterThan(keypad.indexOf("const expanded = state.keysExpanded"));
    expect(keypad).toContain('state.padKind === "slash"');
  });

  test("slash chips fill compose instead of sending keys", async () => {
    const tokens: string[] = [];
    await act(() => {
      renderReactScreen(createElement(SessionSlashPad, { onSelect: (text: string) => tokens.push(text) }));
    });
    const chip = app.querySelector<HTMLButtonElement>(".slash-cmd")!;
    await act(() => { chip.click(); });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.startsWith("/")).toBeTrue();
    expect(slashView).toContain("setComposeText");
    expect(slashView).toContain("onSelect(command.token)");
    expect(slashView).not.toContain("queueKey");
    expect(slashView).not.toContain("sendPad");
    expect(compose).toContain("export function setComposeText");
  });

  test("switching morphs the expanded body and drops latched modifiers", () => {
    state.padKind = "keys";
    pressModifier("ctrl");
    let painted = 0;
    selectPadKind("slash", () => { painted++; });
    expect(state.padKind).toBe("slash");
    expect(painted).toBe(1);
    expect(withModifiers("c")).toEqual(["c"]);
    expect(pad).toContain("clearModifiers()");
    expect(pad).toContain("savePadKind()");
    expect(slashView).toContain('t("slash.keys")');
    expect(slashView).toContain('t("slash.commands")');
  });
});
