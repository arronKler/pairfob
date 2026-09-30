import { describe, expect, test } from "bun:test";
import { computeLayout, type LayoutInput } from "./layout";

function input(overrides: Partial<LayoutInput> = {}): LayoutInput {
  return {
    phase: "live",
    screen: "home",
    fullTerminal: false,
    agentChat: false,
    desk: false,
    hasSelectedPane: false,
    termFontPx: 12,
    operationBusy: false,
    ...overrides,
  };
}

describe("composition selection", () => {
  test("boot and resume render the boot page before anything live", () => {
    expect(computeLayout(input({ phase: "boot" })).mode).toBe("boot");
    expect(computeLayout(input({ phase: "resuming" })).mode).toBe("boot");
    // The phone boots inside the list frame: tab bar in place, no splash, no lock.
    const phone = computeLayout(input({ phase: "resuming", screen: "pane" }));
    expect(phone.shell.booting).toBeFalse();
    expect(phone.shell.tabs).toBeTrue();
    expect(phone.lockScroll).toBeFalse();
    // The desktop keeps the centered splash.
    const desk = computeLayout(input({ phase: "boot", desk: true }));
    expect(desk.shell.booting).toBeTrue();
    expect(desk.shell.tabs).toBeFalse();
    expect(desk.lockScroll).toBeTrue();
  });

  test("pairing and the computer picker own their phases", () => {
    expect(computeLayout(input({ phase: "connect" })).mode).toBe("connect");
    expect(computeLayout(input({ phase: "pairing" })).mode).toBe("connect");
    expect(computeLayout(input({ phase: "pick" })).mode).toBe("pick");
    expect(computeLayout(input({ phase: "connect" })).lockScroll).toBeFalse();
  });

  test("the workspace wins over the desk and the pane; the phone board owns its screen", () => {
    expect(computeLayout(input({ screen: "workspace" })).mode).toBe("workspace");
    expect(computeLayout(input({ screen: "workspace", desk: true })).mode).toBe("workspace");
    expect(computeLayout(input({ screen: "workspace" })).shell.workspace).toBeTrue();
    expect(computeLayout(input({ screen: "board" })).mode).toBe("board");
    expect(computeLayout(input({ screen: "board" })).shell.board).toBeTrue();
  });

  test("a wide board sits in the desk's main column beside the list", () => {
    const board = computeLayout(input({ screen: "board", desk: true, hasSelectedPane: true }));
    expect(board.mode).toBe("desk");
    expect(board.deskPage).toBe("board");
    expect(board.deskChild).toBeNull();
    expect(board.shell.desk).toBeTrue();
    expect(board.shell.board).toBeFalse();
    expect(board.shell.tabs).toBeFalse();
    expect(board.lockScroll).toBeTrue();
    expect(board.key).not.toBe(computeLayout(input({ screen: "home", desk: true })).key);
  });

  test("a desk pane opened from the board leads back to it; the phone pane keeps its own back", () => {
    expect(computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true, boardReturn: true })).deskReturn).toBe("board");
    expect(computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true })).deskReturn).toBeNull();
    expect(computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true, agentChat: true, boardReturn: true })).deskReturn)
      .toBe("board");
    expect(computeLayout(input({ screen: "pane", boardReturn: true })).deskReturn).toBeNull();
    expect(computeLayout(input({ screen: "board", desk: true, boardReturn: true })).deskReturn).toBeNull();
  });

  test("the complete terminal takes the whole page, even on a wide layout", () => {
    const phone = computeLayout(input({ screen: "pane", fullTerminal: true }));
    const desk = computeLayout(input({ screen: "pane", fullTerminal: true, desk: true }));
    expect(phone.mode).toBe("full-terminal");
    expect(desk.mode).toBe("full-terminal");
    expect(desk.shell.desk).toBeFalse();
    expect(phone.shell.session).toBeTrue();
  });

  test("a wide layout keeps the list beside the page", () => {
    const desk = computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true }));
    expect(desk.mode).toBe("desk");
    expect(desk.deskChild).toBe("session");
    expect(desk.shell.desk).toBeTrue();
    // The pane is beside the list, so it is not the phone session shell.
    expect(desk.shell.session).toBeFalse();
    expect(desk.lockScroll).toBeTrue();

    const chat = computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true, agentChat: true }));
    expect(chat.deskChild).toBe("chat");

    // A pane the daemon no longer reports leaves the main column empty.
    expect(computeLayout(input({ screen: "pane", desk: true })).deskChild).toBeNull();
    expect(computeLayout(input({ screen: "home", desk: true })).deskChild).toBeNull();
  });

  test("the desk main column shows the settings family instead of the pane", () => {
    for (const screen of ["settings", "quota", "computers"] as const) {
      const desk = computeLayout(input({ screen, desk: true, hasSelectedPane: true }));
      expect(desk.mode).toBe("desk");
      expect(desk.deskPage).toBe(screen);
      expect(desk.deskChild).toBeNull();
    }
    expect(computeLayout(input({ screen: "settings", desk: true })).shell.desk).toBeTrue();
  });

  test("a phone renders one page at a time", () => {
    expect(computeLayout(input({ screen: "settings" })).mode).toBe("settings");
    expect(computeLayout(input({ screen: "quota" })).mode).toBe("quota");
    expect(computeLayout(input({ screen: "computers" })).mode).toBe("computers");
    expect(computeLayout(input({ screen: "pane" })).mode).toBe("pane");
    expect(computeLayout(input({ screen: "pane", agentChat: true })).mode).toBe("chat");
    expect(computeLayout(input({ screen: "home" })).mode).toBe("home");
    expect(computeLayout(input({ screen: "pane" })).shell.session).toBeTrue();
    expect(computeLayout(input({ screen: "home" })).shell.session).toBeFalse();
    expect(computeLayout(input({ screen: "home" })).lockScroll).toBeFalse();
  });

  test("terminal metrics and the busy marker follow the domains that own them", () => {
    const layout = computeLayout(input({ termFontPx: 14, operationBusy: true }));
    expect(layout.termFontPx).toBe(14);
    expect(layout.termLineHeightPx).toBe(21);
    expect(layout.operationBusy).toBeTrue();
    expect(computeLayout(input({ termFontPx: 12 })).termLineHeightPx).toBe(18);
  });

  test("the composition key changes only when the page does", () => {
    const home = computeLayout(input());
    expect(computeLayout(input()).key).toBe(home.key);
    // A different pane, a new notice or fresh terminal text is a repaint, not a
    // navigation: the key stays put so the commit does not animate or flush.
    expect(computeLayout(input({ termFontPx: 13 })).key).toBe(home.key);
    expect(computeLayout(input({ operationBusy: true })).key).toBe(home.key);
    expect(computeLayout(input({ screen: "pane" })).key).not.toBe(home.key);
    expect(computeLayout(input({ phase: "resuming" })).key).not.toBe(home.key);
    expect(computeLayout(input({ desk: true, hasSelectedPane: true })).key).not.toBe(home.key);
  });
});

describe("phone tab roots", () => {
  test("home, board and settings carry the tab bar on a phone, and nothing else does", () => {
    expect(computeLayout(input({ screen: "home" })).shell.tabs).toBeTrue();
    expect(computeLayout(input({ screen: "board" })).shell.tabs).toBeTrue();
    expect(computeLayout(input({ screen: "settings" })).shell.tabs).toBeTrue();
    expect(computeLayout(input({ screen: "pane" })).shell.tabs).toBeFalse();
    expect(computeLayout(input({ screen: "quota" })).shell.tabs).toBeFalse();
    expect(computeLayout(input({ screen: "computers" })).shell.tabs).toBeFalse();
    expect(computeLayout(input({ screen: "workspace" })).shell.tabs).toBeFalse();
  });

  test("the desk, full terminal and non-live phases never carry it", () => {
    expect(computeLayout(input({ screen: "home", desk: true })).shell.tabs).toBeFalse();
    expect(computeLayout(input({ screen: "board", desk: true })).shell.tabs).toBeFalse();
    expect(computeLayout(input({ screen: "home", fullTerminal: true })).shell.tabs).toBeFalse();
    expect(computeLayout(input({ phase: "connect" })).shell.tabs).toBeFalse();
  });

  test("the tab flag is part of the composition identity", () => {
    // The wide board left the full-screen board mode; the phone and desktop boot share one.
    const tabs = computeLayout(input({ phase: "resuming" }));
    const plain = computeLayout(input({ phase: "resuming", desk: true }));
    expect(tabs.mode).toBe(plain.mode);
    expect(tabs.key).not.toBe(plain.key);
  });
});
