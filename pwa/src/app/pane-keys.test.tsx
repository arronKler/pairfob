import { expectDifferentNode, expectSameNode } from "../../test-support/node-identity";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { setScreen } from "./navigation-store";
import { DESK_QUERY } from "./viewport";
import { hardwareKeyboard, resetInputMode } from "./input-mode";
import { setPhase } from "../features/connection/connection-store";
import { composeDraft, setComposeDraft, setComposeLive } from "../features/session/compose-store";
import { paneRow, selectPane, setAgentChat, setFullTerminal, setPaneRow, setTermSelect } from "../features/session/session-store";
import { attachLiveSession } from "../features/computers/catalog-store";
import { setLang } from "../lib/i18n";
import { bindPaneKeys, sessionControlHasFocus, sessionHoldsKeys } from "./pane-keys";
import { noteSessionChosen } from "../features/session/focus";
import { dropQueuedKeys, flushKeys } from "../features/session/guided/keys";
import { bindRowBubble } from "../features/session/guided/rowbar";

/**
 * Key routing by focus on the desk: a key reaches the session only while the
 * session column holds the keyboard. The rail, the inspector and every overlay
 * keep their keys, so Ctrl+C beside a diff never interrupts the agent.
 */
let controller: AbortController;
let sent: string[][];
let palette = 0;
const session = {
  isConnected: () => true,
  sendKeys: async (_paneId: string, keys: string[]) => { sent.push(keys); },
} as never;

function desk(): { rail: HTMLElement; main: HTMLElement; inspector: HTMLElement } {
  const app = document.getElementById("app")!;
  app.className = "desk inspector";
  app.innerHTML = `<nav class="rail"><button class="card-main">Row</button><p class="rail-note">Sessions</p></nav>
    <section class="main"><div class="term" tabindex="-1">screen</div><div class="dock-form"><textarea></textarea><button class="send-btn">Send</button></div></section>
    <aside class="inspector"><pre class="diff" tabindex="0">+ line</pre><p class="diff-note">2 files</p><svg class="glyph"></svg></aside>`;
  return { rail: app.querySelector(".rail")!, main: app.querySelector(".main")!, inspector: app.querySelector(".inspector")! };
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("en");
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(false);
  setAgentChat(false);
  setTermSelect(false);
  setComposeDraft("");
  attachLiveSession(session);
  sent = [];
  palette = 0;
  controller = new AbortController();
  bindPaneKeys(controller.signal, () => { palette += 1; });
});

afterEach(() => {
  controller.abort();
  attachLiveSession(null);
  dropQueuedKeys();
  resetInputMode();
  const app = document.getElementById("app")!;
  app.className = "";
  app.innerHTML = "";
  for (const stray of document.querySelectorAll("body > :not(#app)")) stray.remove();
});

function keyOn(target: Node, key: string, init: Record<string, unknown> = {}): KeyboardEvent {
  const event = new happy.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
  target.dispatchEvent(event);
  return event;
}
async function forwarded(target: Node, key = "Escape", init: Record<string, unknown> = {}): Promise<string[][]> {
  sent = [];
  keyOn(target, key, init);
  await act(async () => { await flushKeys(); });
  return sent;
}
const press = (target: Element) => target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);

test("focus inside the session column forwards, on the desk and on the phone", async () => {
  const { main } = desk();
  expect(await forwarded(main.querySelector(".term")!)).toEqual([["esc"]]);
  expect(await forwarded(main.querySelector(".term")!, "c", { ctrlKey: true })).toEqual([["ctrl+c"]]);
  document.getElementById("app")!.className = "";
  expect(await forwarded(main.querySelector(".term")!)).toEqual([["esc"]]);
});

test("controls in the session column still act on their own keys", async () => {
  const { main } = desk();
  expect(await forwarded(main.querySelector(".send-btn")!, "Enter")).toEqual([]);
  expect(await forwarded(main.querySelector(".send-btn")!, " ")).toEqual([]);
  expect(await forwarded(main.querySelector("textarea")!, "x")).toEqual([]);
  expect(composeDraft()).toBe("");
});

test("Enter with a modifier is not a press: on a focused session button it is the session's key, and the button stays unpressed", async () => {
  const { main } = desk();
  const button = main.querySelector<HTMLElement>(".send-btn")!;
  // Composed input has no use for it from the page; the browser must still not press the button.
  const composed = keyOn(button, "Enter", { shiftKey: true });
  expect(composed.defaultPrevented).toBeTrue();
  expect(await forwarded(button, "Enter", { shiftKey: true })).toEqual([]);
  // The plain press is the button's own, untouched.
  expect(keyOn(button, "Enter").defaultPrevented).toBeFalse();
  expect(keyOn(button, " ").defaultPrevented).toBeFalse();
  // Live input: Shift+Enter is the program's line feed from wherever focus rests.
  setComposeLive(true);
  try {
    const live = await forwarded(button, "Enter", { shiftKey: true });
    expect(live).toHaveLength(1);
    expect(await forwarded(main.querySelector(".term")!, "Enter", { shiftKey: true })).toEqual(live);
    expect(keyOn(button, "Enter", { ctrlKey: true }).defaultPrevented).toBeTrue();
    expect(await forwarded(button, "Enter")).toEqual([]);
  } finally { setComposeLive(false); }
});

test("a character typed with focus left on a session button reaches the compose field", async () => {
  const { main } = desk();
  const button = main.querySelector<HTMLElement>(".send-btn")!;
  // Where a click left it: the `···` button after its panel closed, the files button.
  expect(keyOn(button, "g").defaultPrevented).toBeTrue();
  expect(keyOn(button, "O", { shiftKey: true }).defaultPrevented).toBeTrue();
  expect(composeDraft()).toBe("gO");
  expectSameNode(document.activeElement, main.querySelector("textarea"));
  // A Command chord is still the browser's (the rest of the rule: pane-keys.controls.test).
  expect(keyOn(button, "v", { metaKey: true }).defaultPrevented).toBeFalse();
  expect(composeDraft()).toBe("gO");
});

test("a button in the rail or the inspector, or under a dialog, passes no character on", () => {
  const { rail, main, inspector } = desk();
  inspector.insertAdjacentHTML("beforeend", `<button class="stage">Stage</button>`);
  expect(keyOn(rail.querySelector(".card-main")!, "x").defaultPrevented).toBeFalse();
  expect(keyOn(inspector.querySelector(".stage")!, "x").defaultPrevented).toBeFalse();
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  dialog.showModal();
  expect(keyOn(main.querySelector(".send-btn")!, "x").defaultPrevented).toBeFalse();
  dialog.close();
  expect(composeDraft()).toBe("");
});

test("without a hardware keyboard a focused button keeps every key, as on the phone", () => {
  const { main } = desk();
  const restore = touchTablet(false);
  try {
    expect(keyOn(main.querySelector(".send-btn")!, "x").defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("");
  } finally {
    restore();
  }
});

test("focus in the rail or the inspector never forwards, Ctrl+C included", async () => {
  const { rail, inspector } = desk();
  expect(await forwarded(rail.querySelector(".rail-note")!)).toEqual([]);
  expect(await forwarded(inspector.querySelector(".diff")!, "c", { ctrlKey: true })).toEqual([]);
  expect(await forwarded(inspector.querySelector(".diff")!, "x")).toEqual([]);
  expect(composeDraft()).toBe("");
});

test("a press on non-focusable rail or inspector content keeps <body> keys away from the session", async () => {
  const { rail, main, inspector } = desk();
  press(inspector.querySelector(".diff-note")!);
  expect(await forwarded(document.body, "c", { ctrlKey: true })).toEqual([]);
  press(rail.querySelector(".rail-note")!);
  expect(await forwarded(document.body)).toEqual([]);
  // An icon is not an HTMLElement; a press on one holds the keyboard all the same.
  press(main.querySelector(".term")!);
  press(inspector.querySelector(".glyph")!);
  expect(await forwarded(document.body)).toEqual([]);
  // Pressing or focusing in the session hands the keyboard back.
  press(main.querySelector(".term")!);
  expect(await forwarded(document.body)).toEqual([["esc"]]);
  press(inspector.querySelector(".diff-note")!);
  main.querySelector(".term")!.dispatchEvent(new happy.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
  expect(await forwarded(document.body)).toEqual([["esc"]]);
  // A closed inspector no longer holds anything.
  press(inspector.querySelector(".diff-note")!);
  inspector.remove();
  expect(await forwarded(document.body)).toEqual([["esc"]]);
  // Rebuilt after a rotation or a narrow window, it is the same place the
  // reader was working in, and it holds the keyboard again.
  const rebuilt = document.createElement("aside");
  rebuilt.className = "inspector";
  rebuilt.innerHTML = `<p class="diff-note">2 files</p>`;
  document.getElementById("app")!.append(rebuilt);
  expect(await forwarded(document.body, "c", { ctrlKey: true })).toEqual([]);
  // Until the reader presses in the session.
  press(main.querySelector(".term")!);
  expect(await forwarded(document.body)).toEqual([["esc"]]);
});

/** The list beside the session, as wide as the desk shell needs. */
function besideList(): () => void {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  return () => happy.happyDOM.setWindowSize({ width: 390, height: 844 });
}

test("the row that opened the session passes its keys on, until the reader presses elsewhere", async () => {
  const restore = besideList();
  try {
    const { rail, main } = desk();
    const row = rail.querySelector<HTMLElement>(".card-main")!;
    press(row);
    row.focus();
    // Focus in the list alone: the list's keys.
    expect(await forwarded(row)).toEqual([]);

    // The press opened the session: choosing it is choosing the session column.
    noteSessionChosen();
    expect(await forwarded(row)).toEqual([["esc"]]);
    expect(await forwarded(row, "c", { ctrlKey: true })).toEqual([["ctrl+c"]]);
    // The row still answers the keys that press it, and Tab still walks the page.
    expect(keyOn(row, "Enter").defaultPrevented).toBeFalse();
    expect(keyOn(row, " ").defaultPrevented).toBeFalse();
    expect(keyOn(row, "Tab").defaultPrevented).toBeFalse();
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["ctrl+c"]]);
    // A character starts the draft and takes the caret out of the list.
    expect(keyOn(row, "h").defaultPrevented).toBeTrue();
    expect(composeDraft()).toBe("h");
    expectSameNode(document.activeElement, main.querySelector("textarea"));

    // Back on the row by the keyboard: that is the reader in the list again.
    row.focus();
    expect(await forwarded(row)).toEqual([]);
    // Chosen once more, then a press on something else in the list.
    noteSessionChosen();
    expect(await forwarded(row)).toEqual([["esc"]]);
    press(rail.querySelector(".rail-note")!);
    expect(await forwarded(row)).toEqual([]);
    expect(await forwarded(row, "x")).toEqual([]);
    expect(composeDraft()).toBe("h");
  } finally {
    restore();
  }
});

test("where a pressed row takes no focus, the page's keys are the chosen session's", async () => {
  const restore = besideList();
  try {
    const { rail, inspector } = desk();
    // Safari leaves focus on <body>; the list is still the last column pressed.
    press(rail.querySelector(".card-main")!);
    expect(await forwarded(document.body)).toEqual([]);
    noteSessionChosen();
    expect(await forwarded(document.body)).toEqual([["esc"]]);
    expect(await forwarded(document.body, "Enter")).toEqual([["enter"]]);
    press(inspector.querySelector(".diff-note")!);
    expect(await forwarded(document.body)).toEqual([]);
    expect(await forwarded(document.body, "c", { ctrlKey: true })).toEqual([]);
  } finally {
    restore();
  }
});

test("a field that chose the session keeps what is typed into it, and a dialog keeps everything", async () => {
  const restore = besideList();
  try {
    const { rail } = desk();
    rail.insertAdjacentHTML("afterbegin", `<input class="rail-find">`);
    const find = rail.querySelector<HTMLInputElement>(".rail-find")!;
    press(find);
    find.focus();
    noteSessionChosen();
    expect(keyOn(find, "x").defaultPrevented).toBeFalse();
    expect(await forwarded(find)).toEqual([]);
    expect(await forwarded(find, "c", { ctrlKey: true })).toEqual([]);

    const row = rail.querySelector<HTMLElement>(".card-main")!;
    press(row);
    row.focus();
    noteSessionChosen();
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.showModal();
    expect(await forwarded(row)).toEqual([]);
    expect(keyOn(row, "x").defaultPrevented).toBeFalse();
    dialog.close();
    expect(composeDraft()).toBe("");
  } finally {
    restore();
  }
});

test("on a touch tablet the first key after a tapped row proves the keyboard and is the session's", async () => {
  const restoreWidth = besideList();
  const restore = touchTablet();
  try {
    const { rail, main } = desk();
    const row = rail.querySelector<HTMLElement>(".card-main")!;
    press(row);
    row.focus();
    noteSessionChosen();
    // Nothing was focused for the reader: a field on glass raises the keys.
    expect(hardwareKeyboard()).toBeFalse();
    expectSameNode(document.activeElement, row);
    expect(await forwarded(row)).toEqual([["esc"]]);
    expect(hardwareKeyboard()).toBeTrue();
    expect(keyOn(row, "h").defaultPrevented).toBeTrue();
    expect(composeDraft()).toBe("h");
    expectSameNode(document.activeElement, main.querySelector("textarea"));
  } finally {
    restore();
    restoreWidth();
  }
});

test("a phone layout has no list beside the session: a chosen row passes nothing on", async () => {
  const { rail } = desk();
  const row = rail.querySelector<HTMLElement>(".card-main")!;
  press(row);
  row.focus();
  noteSessionChosen();
  // A narrow window under a mouse.
  expect(await forwarded(row)).toEqual([]);
  // And glass, where no key ever proves a keyboard.
  const restore = touchTablet(false);
  try {
    expect(await forwarded(row)).toEqual([]);
    expect(keyOn(row, "h").defaultPrevented).toBeFalse();
    expect(composeDraft()).toBe("");
  } finally {
    restore();
  }
});

test("menus, panels, palettes and anything outside the app keep their keys", async () => {
  desk();
  const host = document.createElement("div");
  host.innerHTML = `<div role="menu"><span class="item" tabindex="-1">Pin</span></div>
    <div class="command-palette"><span class="hit" tabindex="-1">Hit</span></div>
    <div role="dialog"><span class="copy" tabindex="-1">Copy</span></div>
    <span class="toast" tabindex="-1">Saved</span>`;
  document.body.append(host);
  for (const selector of [".item", ".hit", ".copy", ".toast"]) {
    expect(await forwarded(host.querySelector(selector)!), selector).toEqual([]);
  }
});

test("an open popover dialog blocks the session even after focus drops to <body>", async () => {
  desk();
  const popover = document.createElement("dialog");
  popover.dataset.popover = "menu";
  document.body.append(popover);
  popover.showModal();
  expect(await forwarded(document.body)).toEqual([]);
  expect(await forwarded(document.body, "x")).toEqual([]);
  popover.close();
  expect(await forwarded(document.body)).toEqual([["esc"]]);
});

test("Escape closes the open row actions before the session gets one, from the body or the field", async () => {
  const { main, inspector } = desk();
  const field = main.querySelector("textarea")!;
  // The compose field forwards its own keys; this stands in for that binding.
  let fieldKeys = 0;
  field.addEventListener("keydown", () => { fieldKeys += 1; });
  for (const target of [document.body, field]) {
    const bubble = document.createElement("div");
    bubble.className = "row-bubble";
    main.append(bubble);
    setPaneRow(0);
    const release = bindRowBubble(bubble, 0);
    expect(await forwarded(target)).toEqual([]);
    expect(paneRow()).toBeNull();
    expect(fieldKeys).toBe(0);
    // The bubble unmounts with its row; the next Escape is an ordinary key again.
    release();
    bubble.remove();
  }
  expect(await forwarded(document.body)).toEqual([["esc"]]);
  keyOn(field, "Escape");
  expect(fieldKeys).toBe(1);
  // Focus in the inspector: its Escape (setting a half-written note aside) is not the bubble's to take.
  const bubble = document.createElement("div");
  main.append(bubble);
  setPaneRow(0);
  const release = bindRowBubble(bubble, 0);
  const event = keyOn(inspector.querySelector(".diff")!, "Escape");
  expect(event.defaultPrevented).toBeFalse();
  expect(paneRow()).toBe(0);
  release();
  setPaneRow(null);
});

/** The conversation view's column: its header, a focusable transcript, and the draft field. */
function chatDesk(): { main: HTMLElement; inspector: HTMLElement; stream: HTMLElement; field: HTMLTextAreaElement } {
  const { main, inspector } = desk();
  main.innerHTML = `<header class="chrome"><button class="more">More</button></header>
    <div class="agent-stream" tabindex="0"><p>reply</p><details><summary class="work-head">2 steps</summary></details>
      <button class="copy">Copy</button><a class="link" href="#">docs</a></div>
    <div class="dock agent-dock"><textarea></textarea></div>`;
  setAgentChat(true);
  const stream = main.querySelector<HTMLElement>(".agent-stream")!;
  Object.defineProperties(stream, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 3000 } });
  stream.scrollTop = 1000;
  return { main, inspector, stream, field: main.querySelector("textarea")! };
}

test("in a conversation a typed character starts the draft and takes the caret to the field", async () => {
  const { stream, field } = chatDesk();
  let inputs = 0;
  field.addEventListener("input", () => { inputs += 1; });
  expect(keyOn(document.body, "h").defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, field);
  expect(keyOn(stream, "I", { shiftKey: true }).defaultPrevented).toBeTrue();
  expect([field.value, field.selectionStart, inputs]).toEqual(["hI", 2, 2]);
  // Nothing is a PTY key here: a conversation only ever receives a prompt.
  expect(await forwarded(stream, "Escape")).toEqual([]);
  expect(await forwarded(stream, "c", { ctrlKey: true })).toEqual([]);
});

test("the transcript keeps its reading keys, and chords stay the browser's", () => {
  const { stream, field } = chatDesk();
  for (const [name, init] of [[" ", {}], ["PageDown", {}], ["ArrowDown", {}], ["Enter", {}], ["c", { metaKey: true }], ["c", { ctrlKey: true }], ["a", { altKey: true }], ["a", { isComposing: true }]] as const) {
    expect(keyOn(stream, name, init).defaultPrevented, name).toBeFalse();
  }
  // A button, a step heading or a link in the transcript is pressed by Enter and Space.
  for (const selector of [".copy", ".work-head", ".link"]) {
    for (const name of ["Enter", " "]) expect(keyOn(stream.querySelector(selector)!, name).defaultPrevented, selector).toBeFalse();
  }
  expect(stream.scrollTop).toBe(1000);
  expect(field.value).toBe("");
  expectDifferentNode(document.activeElement, field);
});

test("a character typed with focus left on a step heading, a copy button or `···` starts the draft", () => {
  const { main, stream, field } = chatDesk();
  // The click that opened the step, copied the reply or closed the panel left focus there.
  expect(keyOn(stream.querySelector(".work-head")!, "a").defaultPrevented).toBeTrue();
  expect(keyOn(stream.querySelector(".copy")!, "b").defaultPrevented).toBeTrue();
  expect(keyOn(stream.querySelector(".link")!, "c").defaultPrevented).toBeTrue();
  expect(keyOn(main.querySelector(".more")!, "d").defaultPrevented).toBeTrue();
  expect(field.value).toBe("abcd");
  expectSameNode(document.activeElement, field);
});

test("a conversation's reading keys scroll it from the page and from a control outside it", () => {
  const { main, stream, field } = chatDesk();
  // On load focus is on <body>: the browser has no scroller to send these to.
  expect(keyOn(document.body, "PageUp").defaultPrevented).toBeTrue();
  expect(stream.scrollTop).toBe(475);
  expect(keyOn(document.body, "ArrowDown").defaultPrevented).toBeTrue();
  expect(stream.scrollTop).toBe(515);
  expect(keyOn(document.body, " ").defaultPrevented).toBeTrue();
  expect(stream.scrollTop).toBe(1040);
  expect(keyOn(main.querySelector(".more")!, "End").defaultPrevented).toBeTrue();
  expect(stream.scrollTop).toBe(2400);
  expect(keyOn(main.querySelector(".more")!, "Home").defaultPrevented).toBeTrue();
  expect(stream.scrollTop).toBe(0);
  // Space and Enter on that control still press it.
  expect(keyOn(main.querySelector(".more")!, " ").defaultPrevented).toBeFalse();
  expect(keyOn(main.querySelector(".more")!, "Enter").defaultPrevented).toBeFalse();
  expect(stream.scrollTop).toBe(0);
  // The field's own listener is the component's; from here the page takes nothing.
  expect(keyOn(field, "ArrowDown").defaultPrevented).toBeFalse();
  expect(stream.scrollTop).toBe(0);
});

test("reading keys stay put for another column, a dialog, and glass with no keyboard", () => {
  const { inspector, stream, field } = chatDesk();
  expect(keyOn(inspector.querySelector(".diff")!, "PageUp").defaultPrevented).toBeFalse();
  press(inspector.querySelector(".diff-note")!);
  expect(keyOn(document.body, "PageUp").defaultPrevented).toBeFalse();
  press(field);
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  dialog.showModal();
  expect(keyOn(document.body, "PageUp").defaultPrevented).toBeFalse();
  dialog.close();
  const restore = touchTablet(false);
  try {
    expect(keyOn(document.body, "PageUp").defaultPrevented).toBeFalse();
  } finally {
    restore();
  }
  expect(stream.scrollTop).toBe(1000);
});

test("a conversation's draft takes no key from another column, a dialog, or a field that cannot send", () => {
  const { inspector, field } = chatDesk();
  expect(keyOn(inspector.querySelector(".diff")!, "x").defaultPrevented).toBeFalse();
  press(inspector.querySelector(".diff-note")!);
  expect(keyOn(document.body, "x").defaultPrevented).toBeFalse();
  press(field);
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  dialog.showModal();
  expect(keyOn(document.body, "x").defaultPrevented).toBeFalse();
  dialog.close();
  field.disabled = true;
  expect(keyOn(document.body, "x").defaultPrevented).toBeFalse();
  expect(field.value).toBe("");
});

test("a conversation on glass waits for a tap: a key never focuses the field without a hardware keyboard", () => {
  const { field } = chatDesk();
  const restore = touchTablet(false);
  try {
    expect(keyOn(document.body, "x").defaultPrevented).toBeFalse();
    expect(field.value).toBe("");
    expectDifferentNode(document.activeElement, field);
  } finally {
    restore();
  }
});

test("the routing rule itself", () => {
  const { rail, main, inspector } = desk();
  expect(sessionHoldsKeys(document.body, null)).toBeTrue();
  expect(sessionHoldsKeys(document.body, inspector)).toBeFalse();
  expect(sessionHoldsKeys(main.querySelector(".term"), rail)).toBeTrue();
  expect(sessionHoldsKeys(rail.querySelector(".card-main"), null)).toBeFalse();
  expect(sessionHoldsKeys(inspector.querySelector(".diff"), null)).toBeFalse();
  // A button is not the session's keyboard, but one in its column lets typing through.
  expect(sessionHoldsKeys(main.querySelector(".send-btn"), null)).toBeFalse();
  expect(sessionControlHasFocus(main.querySelector(".send-btn"))).toBeTrue();
  expect(sessionControlHasFocus(main.querySelector("textarea"))).toBeFalse();
  expect(sessionControlHasFocus(main.querySelector(".term"))).toBeFalse();
  expect(sessionControlHasFocus(rail.querySelector(".card-main"))).toBeFalse();
  expect(sessionControlHasFocus(document.body)).toBeFalse();
});

test("a dialog opened from the inspector hands the keyboard back to it, not to the session", async () => {
  const { main, inspector } = desk();
  press(inspector.querySelector(".diff-note")!);
  // A note editor, a branch sheet or a menu: pressed and focused in, then closed.
  const dialog = document.createElement("dialog");
  dialog.innerHTML = "<textarea></textarea><button>Save</button>";
  document.body.append(dialog);
  dialog.querySelector("textarea")!.dispatchEvent(new happy.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
  press(dialog.querySelector("button")!);
  dialog.remove();
  expect(await forwarded(document.body)).toEqual([]);
  expect(await forwarded(document.body, "c", { ctrlKey: true })).toEqual([]);
  // The same visit from the session leaves the session holding the keyboard.
  press(main.querySelector(".term")!);
  const second = document.createElement("dialog");
  second.innerHTML = "<button>Close</button>";
  document.body.append(second);
  press(second.querySelector("button")!);
  second.remove();
  expect(await forwarded(document.body)).toEqual([["esc"]]);
});

/** A touch tablet beside the list: wide enough for the desk, no hovering fine pointer. */
function touchTablet(desk = true): () => void {
  const matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: desk && query === DESK_QUERY, media: query })) as typeof window.matchMedia;
  return () => { window.matchMedia = matchMedia; };
}

test("a key outside any field proves a hardware keyboard on a touch tablet", () => {
  const restore = touchTablet();
  try {
    expect(hardwareKeyboard()).toBeFalse();
    // What an on-screen keyboard can produce proves nothing: a key in a field,
    // or the composition placeholder some of them report.
    const field = document.createElement("textarea");
    document.body.append(field);
    keyOn(field, "a");
    keyOn(document.body, "Unidentified", { keyCode: 229 });
    expect(hardwareKeyboard()).toBeFalse();
    keyOn(document.body, "Shift");
    expect(hardwareKeyboard()).toBeTrue();
  } finally {
    restore();
  }
});

test("a phone layout never infers a hardware keyboard", () => {
  const restore = touchTablet(false);
  try {
    keyOn(document.body, "Shift");
    expect(hardwareKeyboard()).toBeFalse();
  } finally {
    restore();
  }
});

const platform = (value: string) => Object.defineProperty(navigator, "platform", { value, configurable: true });
const chord = (target: Node, init: Record<string, unknown> = { metaKey: true }) => keyOn(target, "k", init);

test("⌘K opens the palette from anywhere on macOS, and nothing else does", async () => {
  const original = navigator.platform;
  try {
    platform("MacIntel");
    const { rail, main } = desk();
    expect(chord(document.body).defaultPrevented).toBeTrue();
    chord(rail.querySelector(".card-main")!);
    chord(main.querySelector("textarea")!);
    // A component that swallows its own keys cannot swallow the shortcut.
    main.addEventListener("keydown", event => event.stopPropagation());
    chord(main.querySelector(".term")!, { metaKey: true, key: "K" });
    expect(palette).toBe(4);
    for (const init of [{ metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { metaKey: true, ctrlKey: true }, { metaKey: true, repeat: true }]) {
      expect(chord(document.body, init).defaultPrevented, JSON.stringify(init)).toBeFalse();
    }
    // Ctrl+K stays the terminal's "kill line".
    expect(await forwarded(document.body, "k", { ctrlKey: true })).toEqual([["ctrl+k"]]);
    setPhase("connect");
    chord(document.body);
    setPhase("live");
    platform("Win32");
    chord(document.body);
    platform("Linux x86_64");
    chord(document.body, { metaKey: true });
    expect(palette).toBe(4);
  } finally {
    platform(original);
  }
});

test("⌘K waits behind a blocking dialog, and steps over an open menu or panel", async () => {
  const original = navigator.platform;
  const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
  try {
    platform("MacIntel");
    desk();
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    dialog.showModal();
    expect(chord(document.body).defaultPrevented).toBeFalse();
    expect(palette).toBe(0);
    dialog.close();

    dialog.dataset.popover = "menu";
    dialog.showModal();
    let openWhenPaletteRan: boolean | null = null;
    controller.abort();
    controller = new AbortController();
    bindPaneKeys(controller.signal, () => { palette += 1; openWhenPaletteRan = dialog.open; });
    expect(chord(document.body).defaultPrevented).toBeTrue();
    expect(dialog.open).toBeFalse();
    await pause(10);
    expect(palette).toBe(1);
    expect(openWhenPaletteRan).toBe(false);
  } finally {
    platform(original);
  }
});
