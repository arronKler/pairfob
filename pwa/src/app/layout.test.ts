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

  test("an unreachable only-computer is explained inside the list's frame: the phone's tab bar, the desk's rail", () => {
    const phone = computeLayout(input({ phase: "pick", unreachable: true }));
    expect(phone.shell.unreachable).toBeTrue();
    expect(phone.shell.tabs).toBeTrue();
    expect(phone.shell.desk).toBeFalse();
    expect(phone.lockScroll).toBeFalse();
    const wide = computeLayout(input({ phase: "pick", unreachable: true, desk: true }));
    expect(wide.mode).toBe("pick");
    expect(wide.shell.unreachable).toBeTrue();
    expect(wide.shell.tabs).toBeFalse();
    // The rail stays and the explanation is the main column's page: the desk shell, with nothing live in it.
    expect(wide.shell.desk).toBeTrue();
    expect(wide.lockScroll).toBeTrue();
    expect(wide.deskPage).toBeNull();
    expect(wide.deskChild).toBeNull();
    expect(wide.shell.railHidden).toBeFalse();
    // With a choice of computers the picker stays the page, outside any frame.
    const picker = computeLayout(input({ phase: "pick", desk: true }));
    expect(picker.shell.unreachable).toBeFalse();
    expect(picker.shell.desk).toBeFalse();
    expect(picker.key).not.toBe(wide.key);
  });

  test("the page's own retry keeps the desk frame instead of the splash; any other reconnect is the splash", () => {
    const retry = computeLayout(input({ phase: "resuming", desk: true, retrying: true }));
    expect(retry.mode).toBe("boot");
    expect(retry.shell.desk).toBeTrue();
    expect(retry.shell.booting).toBeFalse();
    expect(retry.lockScroll).toBeTrue();
    const splash = computeLayout(input({ phase: "resuming", desk: true }));
    expect(splash.shell.booting).toBeTrue();
    expect(splash.shell.desk).toBeFalse();
    expect(splash.key).not.toBe(retry.key);
    // Reading the stored computers is never that retry, whatever the flag still says.
    expect(computeLayout(input({ phase: "boot", desk: true, retrying: true })).shell.booting).toBeTrue();
    // The phone's boot frame decides for itself; its descriptor does not change.
    const phone = computeLayout(input({ phase: "resuming", retrying: true }));
    expect(phone).toEqual(computeLayout(input({ phase: "resuming" })));
    expect(phone.shell.desk).toBeFalse();
    expect(phone.shell.tabs).toBeTrue();
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

  test("in the narrowest tier the list gives way to the board, as it does to the inspector", () => {
    const narrow = computeLayout(input({ screen: "board", desk: true, narrow: true, hasSelectedPane: true }));
    expect(narrow.mode).toBe("desk");
    expect(narrow.deskPage).toBe("board");
    expect(narrow.shell.desk).toBeTrue();
    expect(narrow.shell.railHidden).toBeTrue();
    expect(narrow.shell.inspector).toBeFalse();
    // With the roomy tier's width the board sits beside the list, as before.
    expect(computeLayout(input({ screen: "board", desk: true, narrow: false })).shell.railHidden).toBeFalse();
    expect(computeLayout(input({ screen: "board", desk: true })).shell.railHidden).toBeFalse();
    // Only the board: a session, the settings family and the empty main keep the list in that tier.
    for (const screen of ["home", "pane", "settings", "quota", "computers"] as const) {
      expect(computeLayout(input({ screen, desk: true, narrow: true, hasSelectedPane: true })).shell.railHidden).toBeFalse();
    }
    // A pane opened from that board is a session again: the list is back, with the way to the board above it.
    const opened = computeLayout(input({ screen: "pane", desk: true, narrow: true, hasSelectedPane: true, boardReturn: true }));
    expect(opened.shell.railHidden).toBeFalse();
    expect(opened.deskReturn).toBe("board");
    // The phone board is its own screen and never the desk's page.
    const phone = computeLayout(input({ screen: "board", narrow: true }));
    expect(phone.shell.railHidden).toBeFalse();
    expect(phone.shell.tabs).toBeTrue();
    // Rotating changes the shell, not the page: no navigation, the board keeps its state.
    expect(narrow.key).toBe(computeLayout(input({ screen: "board", desk: true, hasSelectedPane: true })).key);
  });

  test("a desk pane opened from the board leads back to it; the phone pane keeps its own back", () => {
    expect(computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true, boardReturn: true })).deskReturn).toBe("board");
    expect(computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true })).deskReturn).toBeNull();
    expect(computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true, agentChat: true, boardReturn: true })).deskReturn)
      .toBe("board");
    expect(computeLayout(input({ screen: "pane", boardReturn: true })).deskReturn).toBeNull();
    expect(computeLayout(input({ screen: "board", desk: true, boardReturn: true })).deskReturn).toBeNull();
  });

  test("the complete terminal owns the phone page and stays beside the list on a wide layout", () => {
    const phone = computeLayout(input({ screen: "pane", fullTerminal: true }));
    const desk = computeLayout(input({ screen: "pane", fullTerminal: true, desk: true }));
    expect(phone.mode).toBe("full-terminal");
    expect(phone.shell.session).toBeTrue();
    expect(desk.mode).toBe("desk");
    expect(desk.deskChild).toBe("full");
    expect(desk.shell.desk).toBeTrue();
    expect(desk.shell.session).toBeFalse();
    // A phone on its side is wide enough for the list but keeps its terminal whole.
    const sideways = computeLayout(input({ screen: "pane", fullTerminal: true, desk: true, handheld: true }));
    expect(sideways.mode).toBe("full-terminal");
    expect(sideways.shell.desk).toBeFalse();
    expect(sideways.shell.session).toBeTrue();
    expect(computeLayout(input({ screen: "pane", desk: true, hasSelectedPane: true, handheld: true })).mode).toBe("desk");
    // A settings-family page or the board takes the main column from it.
    expect(computeLayout(input({ screen: "settings", fullTerminal: true, desk: true })).deskChild).toBeNull();
  });

  test("the inspector sits beside a desk session and never exists on a phone", () => {
    const open = { screen: "pane", desk: true, hasSelectedPane: true, inspector: true } as const;
    const three = computeLayout(input({ ...open, wide: true }));
    expect(three.shell.inspector).toBeTrue();
    expect(three.shell.railHidden).toBeFalse();
    // Without room for three columns the list gives its column away.
    const two = computeLayout(input(open));
    expect(two.shell.inspector).toBeTrue();
    expect(two.shell.railHidden).toBeTrue();
    // It belongs to a session: no session, a settings page or the board means no inspector.
    expect(computeLayout(input({ screen: "home", desk: true, inspector: true })).shell.inspector).toBeFalse();
    expect(computeLayout(input({ ...open, screen: "settings" })).shell.inspector).toBeFalse();
    expect(computeLayout(input({ ...open, screen: "board" })).shell.inspector).toBeFalse();
    expect(computeLayout(input({ screen: "pane", hasSelectedPane: true, inspector: true })).shell.inspector).toBeFalse();
    // Opening it changes the shell, not the page: no navigation, no transition.
    expect(two.key).toBe(computeLayout(input({ ...open, inspector: false })).key);
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
