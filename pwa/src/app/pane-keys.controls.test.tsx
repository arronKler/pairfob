import { expectSameNode } from "../../test-support/node-identity";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { setScreen } from "./navigation-store";
import { DESK_QUERY } from "./viewport";
import { resetInputMode } from "./input-mode";
import { setPhase } from "../features/connection/connection-store";
import { composeDraft, setComposeDraft, setComposeLive } from "../features/session/compose-store";
import { selectPane, setAgentChat, setFullTerminal, setTermSelect } from "../features/session/session-store";
import { attachLiveSession } from "../features/computers/catalog-store";
import { inspectorOpen, setInspectorOpen } from "../features/workspace/inspector-store";
import { setLang } from "../lib/i18n";
import { bindPaneKeys } from "./pane-keys";
import { dropQueuedKeys, flushKeys } from "../features/session/guided/keys";

/**
 * What the keyboard means while focus rests on a button of the session column,
 * what live input does with a key pressed on the page, and F6 between the
 * columns: the way a reader without a mouse leaves a session that keeps Tab.
 */
let controller: AbortController;
/** What reached the program, in order: named keys and raw text. */
let sent: Array<string[] | string>;
const session = {
  isConnected: () => true,
  sendKeys: async (_paneId: string, keys: string[]) => { sent.push(keys); },
  sendText: async (_paneId: string, text: string) => { sent.push(text); },
} as never;

function desk(): { app: HTMLElement; rail: HTMLElement; main: HTMLElement; inspector: HTMLElement } {
  const app = document.getElementById("app")!;
  app.className = "desk inspector";
  app.innerHTML = `<nav class="rail"><button class="host">Computer</button>
      <button class="card-main" aria-pressed="false">Other</button><button class="card-main open" aria-pressed="true">Open</button></nav>
    <section class="main"><header><button class="files">Files</button><button class="more">More</button></header>
      <div class="term" tabindex="-1">screen</div>
      <div class="dock"><div role="tablist"><button class="page-dot" role="tab">1</button></div>
        <div role="radiogroup"><button class="seg" role="radio">Compose</button></div>
        <details><summary class="step">Step</summary></details><a class="link" href="#">docs</a>
        <div class="dock-form"><textarea></textarea><button class="send-btn">Send</button></div></div></section>
    <aside class="inspector"><button class="tab" aria-pressed="false">Files</button><button class="tab changes" aria-pressed="true">Changes</button>
      <pre class="diff" tabindex="0">+ line</pre></aside>`;
  return { app, rail: app.querySelector(".rail")!, main: app.querySelector(".main")!, inspector: app.querySelector(".inspector")! };
}

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  setLang("en");
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(false);
  setAgentChat(false);
  setTermSelect(false);
  setComposeDraft("");
  setComposeLive(false);
  attachLiveSession(session);
  sent = [];
  controller = new AbortController();
  bindPaneKeys(controller.signal, () => undefined);
});

afterEach(() => {
  controller.abort();
  attachLiveSession(null);
  dropQueuedKeys();
  setComposeLive(false);
  resetInputMode();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
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
async function forwarded(target: Node, key: string, init: Record<string, unknown> = {}): Promise<Array<string[] | string>> {
  sent = [];
  keyOn(target, key, init);
  await act(async () => { await flushKeys(); });
  return sent;
}
const PLAIN = [".files", ".more", ".send-btn", ".step", ".link"];

test("composed: a focused button, link or step heading routes Esc, the arrows and Ctrl+letter as the page does", async () => {
  const { main } = desk();
  for (const selector of PLAIN) {
    const control = main.querySelector<HTMLElement>(selector)!;
    expect(await forwarded(control, "Escape"), selector).toEqual([["esc"]]);
    expect(await forwarded(control, "ArrowUp"), selector).toEqual([["up"]]);
    expect(await forwarded(control, "c", { ctrlKey: true }), selector).toEqual([["ctrl+c"]]);
    // As on the page, composed input has no use for these: nothing is sent, nothing is taken.
    expect(await forwarded(control, "Backspace"), selector).toEqual([]);
    expect(await forwarded(control, "F5"), selector).toEqual([]);
    expect(keyOn(control, "Home").defaultPrevented, selector).toBeFalse();
  }
});

test("a focused button keeps Enter and Space for itself, and Tab and Shift+Tab to move on, in both modes", async () => {
  const { main } = desk();
  for (const live of [false, true]) {
    setComposeLive(live);
    for (const selector of PLAIN) {
      const control = main.querySelector<HTMLElement>(selector)!;
      for (const [key, init] of [["Enter", {}], [" ", {}], ["Tab", {}], ["Tab", { shiftKey: true }]] as const) {
        expect(await forwarded(control, key, init), `${selector} ${key}`).toEqual([]);
        expect(keyOn(control, key, init).defaultPrevented, `${selector} ${key}`).toBeFalse();
      }
    }
  }
  expect(composeDraft()).toBe("");
});

test("Esc on the files button that has its column open closes the column and reaches no session; the next Esc is the session's", async () => {
  const { main } = desk();
  main.querySelector("header")!.innerHTML = `<div class="chrome-actions">
    <button class="icon-workspace" aria-pressed="true">Files</button><button class="icon-more">More</button></div>`;
  const toggle = main.querySelector<HTMLElement>(".icon-workspace")!;
  for (const view of ["composed", "live", "chat", "terminal"] as const) {
    setComposeLive(view === "live");
    setAgentChat(view === "chat");
    setFullTerminal(view === "terminal");
    act(() => setInspectorOpen(true));
    toggle.setAttribute("aria-pressed", "true");
    toggle.focus();
    // Every view binds its own keys after this one and never sees the press.
    const later: string[] = [];
    const seen = (event: Event): void => { later.push((event as KeyboardEvent).key); };
    document.addEventListener("keydown", seen, true);
    sent = [];
    let pressed!: KeyboardEvent;
    act(() => { pressed = keyOn(toggle, "Escape"); });
    // Held: the repeats of the press that closed the column are not the session's either.
    toggle.setAttribute("aria-pressed", "false");
    const held = keyOn(toggle, "Escape", { repeat: true });
    await act(async () => { await flushKeys(); });
    document.removeEventListener("keydown", seen, true);
    expect([inspectorOpen(), pressed.defaultPrevented, held.defaultPrevented, later, sent], view).toEqual([false, true, true, [], []]);
    expectSameNode(document.activeElement, toggle);
    toggle.dispatchEvent(new happy.KeyboardEvent("keyup", { key: "Escape", bubbles: true }) as unknown as Event);
    // The button is a plain one again: the page's rule.
    if (view === "composed" || view === "live") expect(await forwarded(toggle, "Escape"), view).toEqual([["esc"]]);
    else expect(keyOn(toggle, "Escape").defaultPrevented, view).toBeFalse();
  }
});

test("beside an open column, Esc anywhere else in the session stays the session's", async () => {
  const { main } = desk();
  main.querySelector("header")!.innerHTML = `<div class="chrome-actions">
    <button class="icon-workspace" aria-pressed="true">Files</button><button class="icon-more">More</button></div>`;
  act(() => setInspectorOpen(true));
  expect(await forwarded(main.querySelector(".icon-more")!, "Escape")).toEqual([["esc"]]);
  expect(await forwarded(main.querySelector(".term")!, "Escape")).toEqual([["esc"]]);
  expect(await forwarded(document.body, "Escape")).toEqual([["esc"]]);
  // A chord is not "close": it is routed like any other key on a button.
  keyOn(main.querySelector(".icon-workspace")!, "Escape", { shiftKey: true });
  expect(inspectorOpen()).toBeTrue();
  act(() => setInspectorOpen(false));
});

test("live input: every other key pressed on a focused button goes to the program", async () => {
  const { main } = desk();
  setComposeLive(true);
  const button = main.querySelector<HTMLElement>(".more")!;
  expect(await forwarded(button, "Escape")).toEqual([["esc"]]);
  expect(await forwarded(button, "Backspace")).toEqual([["backspace"]]);
  expect(await forwarded(button, "ArrowLeft")).toEqual([["left"]]);
  expect(await forwarded(button, "c", { ctrlKey: true })).toEqual([["ctrl+c"]]);
  expect(await forwarded(button, "Home")).toEqual(["\x1b[H"]);
  expect(await forwarded(button, "Delete")).toEqual(["\x1b[3~"]);
  expect(await forwarded(button, "PageUp")).toEqual(["\x1b[5~"]);
  expect(await forwarded(button, "F5")).toEqual(["\x1b[15~"]);
});

test("a tab, a radio, a menu item, a slider or a field keeps every key typed at it", async () => {
  const { main } = desk();
  main.querySelector(".dock")!.insertAdjacentHTML("beforeend",
    `<button class="item" role="menuitem">Pin</button><div class="divider" role="slider" tabindex="0"></div>
     <button class="opt" role="option">One</button><input class="spin" role="spinbutton"><select class="pick"><option>a</option></select>
     <div class="note" contenteditable="true"></div>`);
  for (const live of [false, true]) {
    setComposeLive(live);
    for (const selector of [".page-dot", ".seg", ".item", ".divider", ".opt", ".spin", ".pick", ".note"]) {
      const control = main.querySelector<HTMLElement>(selector)!;
      for (const [key, init] of [["ArrowRight", {}], ["Escape", {}], ["Home", {}], ["x", {}], ["c", { ctrlKey: true }], ["Backspace", {}]] as const) {
        expect(await forwarded(control, key, init), `${selector} ${key}`).toEqual([]);
        expect(keyOn(control, key, init).defaultPrevented, `${selector} ${key}`).toBeFalse();
      }
    }
  }
  expect(composeDraft()).toBe("");
});

test("live input: Backspace, Tab and Shift+Tab pressed on the page go to the program, as a terminal sends them", async () => {
  const { main } = desk();
  setComposeLive(true);
  for (const target of [document.body, main.querySelector<HTMLElement>(".term")!]) {
    expect(await forwarded(target, "Backspace")).toEqual([["backspace"]]);
    expect(await forwarded(target, "Tab")).toEqual([["tab"]]);
    expect(await forwarded(target, "Tab", { shiftKey: true })).toEqual(["\x1b[Z"]);
    expect(keyOn(target, "Tab").defaultPrevented).toBeTrue();
    // Shift+Enter is a line break (line feed), never a second Enter.
    expect(await forwarded(target, "Enter", { shiftKey: true })).toEqual([["ctrl+j"]]);
    // Ctrl+Shift with a letter is no terminal key, and Command is the browser's.
    expect(await forwarded(target, "C", { ctrlKey: true, shiftKey: true })).toEqual([]);
    expect(keyOn(target, "v", { metaKey: true }).defaultPrevented).toBeFalse();
  }
});

test("composed: Tab and Shift+Tab pressed on the page move focus, and Backspace there deletes nothing", async () => {
  const { main } = desk();
  for (const target of [document.body, main.querySelector<HTMLElement>(".term")!]) {
    expect(await forwarded(target, "Tab")).toEqual([]);
    expect(await forwarded(target, "Tab", { shiftKey: true })).toEqual([]);
    expect(keyOn(target, "Tab").defaultPrevented).toBeFalse();
    expect(await forwarded(target, "Backspace")).toEqual([]);
  }
});

test("live input keeps the phone's rules without a hardware keyboard: no Tab, Backspace or Home leaves the page", async () => {
  const { main } = desk();
  setComposeLive(true);
  const matchMedia = window.matchMedia;
  // Glass at a phone width: no key ever proves a keyboard.
  window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof window.matchMedia;
  try {
    document.getElementById("app")!.className = "";
    const term = main.querySelector<HTMLElement>(".term")!;
    for (const [key, init] of [["Tab", {}], ["Tab", { shiftKey: true }], ["Backspace", {}], ["Home", {}], ["F5", {}], ["F6", {}]] as const) {
      expect(await forwarded(term, key, init), key).toEqual([]);
    }
    expect(await forwarded(term, "Escape")).toEqual([["esc"]]);
  } finally {
    window.matchMedia = matchMedia;
  }
});

test("F6 leaves a live session for the next column and Shift+F6 for the previous one: the keyboard-only way out while Tab is the program's", async () => {
  const { rail, main, inspector } = desk();
  setComposeLive(true);
  const field = main.querySelector("textarea")!;
  field.focus();
  expect(await forwarded(field, "F6")).toEqual([]);
  // The inspector's current tab, then round to the list's open row.
  expectSameNode(document.activeElement, inspector.querySelector(".changes"));
  expect(keyOn(document.activeElement!, "F6").defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, rail.querySelector(".open"));
  keyOn(document.activeElement!, "F6");
  expectSameNode(document.activeElement, field);
  // Backwards from the session: the list.
  keyOn(field, "F6", { shiftKey: true });
  expectSameNode(document.activeElement, rail.querySelector(".open"));
  keyOn(document.activeElement!, "F6", { shiftKey: true });
  expectSameNode(document.activeElement, inspector.querySelector(".changes"));
  expect(sent).toEqual([]);
});

test("F6 works from the page and from a composed field too, and never reaches the program", async () => {
  const { rail, main, inspector } = desk();
  expect(await forwarded(document.body, "F6")).toEqual([]);
  expectSameNode(document.activeElement, inspector.querySelector(".changes"));
  const field = main.querySelector("textarea")!;
  field.focus();
  keyOn(field, "F6", { shiftKey: true });
  expectSameNode(document.activeElement, rail.querySelector(".open"));
  // With a chord it is not this shortcut.
  field.focus();
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) keyOn(field, "F6", init);
  expectSameNode(document.activeElement, field);
});

test("F6 into a complete terminal in composed input lands in its draft field, which is what holds focus there", () => {
  const { rail, main } = desk();
  main.insertAdjacentHTML("afterbegin", `<div class="full-terminal-host" tabindex="0"><textarea class="xterm-helper-textarea" readonly></textarea></div>`);
  main.querySelector(".dock-form")!.innerHTML = `<textarea class="full-terminal-compose-input"></textarea>`;
  setFullTerminal(true);
  rail.querySelector<HTMLElement>(".open")!.focus();
  keyOn(document.activeElement!, "F6", { shiftKey: true });
  // Two columns behind it (the inspector, then the session).
  keyOn(document.activeElement!, "F6", { shiftKey: true });
  expectSameNode(document.activeElement, main.querySelector(".full-terminal-compose-input"));
});

test("with the session alone on screen F6 steps between its input and its header, where Tab moves again", () => {
  const { app, rail, main, inspector } = desk();
  inspector.remove();
  app.className = "desk rail-hidden";
  setComposeLive(true);
  const field = main.querySelector("textarea")!;
  field.focus();
  keyOn(field, "F6");
  expectSameNode(document.activeElement, main.querySelector(".files"));
  // On the button Tab is focus movement again, not the program's.
  expect(keyOn(document.activeElement!, "Tab").defaultPrevented).toBeFalse();
  keyOn(document.activeElement!, "F6");
  expectSameNode(document.activeElement, field);
  expect(rail.contains(document.activeElement)).toBeFalse();
});

test("F6 is left alone under a dialog, on a phone layout and before a keyboard is known", () => {
  const { main } = desk();
  const field = main.querySelector("textarea")!;
  field.focus();
  const dialog = document.createElement("dialog");
  document.body.append(dialog);
  dialog.showModal();
  expect(keyOn(field, "F6").defaultPrevented).toBeFalse();
  dialog.close();
  dialog.remove();
  field.focus();
  const matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: false, media: query })) as typeof window.matchMedia;
  try {
    expect(keyOn(field, "F6").defaultPrevented).toBeFalse();
    expectSameNode(document.activeElement, field);
  } finally {
    window.matchMedia = matchMedia;
  }
  // A touch tablet: F6 is a key no on-screen keyboard has, so it proves the keyboard and acts at once.
  window.matchMedia = ((query: string) => ({ matches: query === DESK_QUERY, media: query })) as typeof window.matchMedia;
  try {
    expect(keyOn(field, "F6").defaultPrevented).toBeTrue();
  } finally {
    window.matchMedia = matchMedia;
  }
});
