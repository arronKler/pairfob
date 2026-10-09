import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { resetInputMode } from "../../../app/input-mode";
import { setComposeDraft, setComposeLive } from "../compose-store";
import { bindTerminalCopyKey, copyTerminalSelection, isControlCopy } from "./full-terminal-copy";
import { bindFullTerminalDeskKeys } from "./full-terminal-desk-keys";
import { replayKeyOnTerminal } from "./full-terminal-key-replay";

/**
 * Ctrl+C at the complete terminal off macOS: it copies what is selected, and
 * with nothing selected it is the interrupt. On macOS Command+C is the copy and
 * Control+C is always the program's.
 */
let original = "";
const platform = (value: string): void => { Object.defineProperty(navigator, "platform", { value, configurable: true }); };

type Clip = { writeText: (text: string) => Promise<void> };
let clipboardSlot: PropertyDescriptor | undefined;
let written: string[] = [];
let allow = true;

function terminalWith(selection: string) {
  const state = { selection, cleared: 0 };
  return {
    state,
    hasSelection: () => state.selection.length > 0,
    getSelection: () => state.selection,
    clearSelection: () => { state.selection = ""; state.cleared++; },
  };
}

function host(): { host: HTMLElement; field: HTMLTextAreaElement; reached: string[] } {
  const el = document.createElement("div");
  el.className = "full-terminal-host";
  const field = document.createElement("textarea");
  field.className = "xterm-helper-textarea";
  el.append(field);
  document.body.append(el);
  /** What xterm's own listener on its field would have been given. */
  const reached: string[] = [];
  field.addEventListener("keydown", (event) => { reached.push(event.key); event.preventDefault(); });
  return { host: el, field, reached };
}

const ctrlC = (init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key: "c", ctrlKey: true, keyCode: 67, bubbles: true, cancelable: true, ...init });

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await resetBoardTestDOM();
  original = navigator.platform;
  clipboardSlot = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  written = [];
  allow = true;
  const clip: Clip = { writeText: (text) => allow ? (written.push(text), Promise.resolve()) : Promise.reject(new Error("denied")) };
  Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true });
});

afterEach(() => {
  platform(original);
  if (clipboardSlot) Object.defineProperty(navigator, "clipboard", clipboardSlot);
  else Reflect.deleteProperty(navigator, "clipboard");
  for (const el of document.querySelectorAll("body > .full-terminal-host")) el.remove();
});

describe("which press is the copy", () => {
  test("Ctrl+C off macOS, and nothing on a Mac", () => {
    platform("Win32");
    expect(isControlCopy(ctrlC())).toBeTrue();
    expect(isControlCopy(ctrlC({ key: "C" }))).toBeTrue();
    // Ctrl+Shift+C, Ctrl+Alt+C and other letters are not it.
    expect(isControlCopy(ctrlC({ shiftKey: true }))).toBeFalse();
    expect(isControlCopy(ctrlC({ altKey: true }))).toBeFalse();
    expect(isControlCopy(ctrlC({ key: "d" }))).toBeFalse();
    platform("Linux x86_64");
    expect(isControlCopy(ctrlC())).toBeTrue();
    platform("MacIntel");
    expect(isControlCopy(ctrlC())).toBeFalse();
  });
});

describe("copying the terminal's selection", () => {
  test("puts it on the clipboard and drops it, so the next Ctrl+C interrupts", async () => {
    const terminal = terminalWith("Loaded 8 files");
    expect(copyTerminalSelection(terminal)).toBeTrue();
    await settle();
    expect(written).toEqual(["Loaded 8 files"]);
    expect(terminal.state.cleared).toBe(1);
    expect(copyTerminalSelection(terminal)).toBeFalse();
  });

  test("with nothing selected, or no terminal, there is nothing to copy", () => {
    expect(copyTerminalSelection(terminalWith(""))).toBeFalse();
    expect(copyTerminalSelection(null)).toBeFalse();
    expect(written).toEqual([]);
  });

  test("a clipboard the browser withholds leaves the selection where it was", async () => {
    allow = false;
    const terminal = terminalWith("still here");
    expect(copyTerminalSelection(terminal)).toBeTrue();
    await settle();
    expect(terminal.state.selection).toBe("still here");
    expect(terminal.state.cleared).toBe(0);
  });
});

describe("Ctrl+C typed into xterm", () => {
  test("off macOS a selection is copied and the program is not interrupted", async () => {
    platform("Win32");
    const { host: el, field, reached } = host();
    const terminal = terminalWith("src/app.ts");
    const unbind = bindTerminalCopyKey(el, () => terminal);
    const event = ctrlC();
    field.dispatchEvent(event);
    await settle();
    expect(event.defaultPrevented).toBeTrue();
    // xterm never saw the key, so no 0x03 went to the program.
    expect(reached).toEqual([]);
    expect(written).toEqual(["src/app.ts"]);
    unbind();
  });

  test("with nothing selected it reaches xterm, which sends the interrupt", () => {
    platform("Win32");
    const { host: el, field, reached } = host();
    const unbind = bindTerminalCopyKey(el, () => terminalWith(""));
    field.dispatchEvent(ctrlC());
    expect(reached).toEqual(["c"]);
    expect(written).toEqual([]);
    unbind();
  });

  test("on a Mac Control+C is the program's even over a selection", () => {
    platform("MacIntel");
    const { host: el, field, reached } = host();
    const terminal = terminalWith("selected");
    const unbind = bindTerminalCopyKey(el, () => terminal);
    field.dispatchEvent(ctrlC());
    expect(reached).toEqual(["c"]);
    expect(written).toEqual([]);
    expect(terminal.state.selection).toBe("selected");
    unbind();
  });

  test("a press replayed from the page meets the same rule, and unbinding ends it", async () => {
    platform("Win32");
    const { host: el, reached } = host();
    const terminal = terminalWith("from the page");
    const unbind = bindTerminalCopyKey(el, () => terminal);
    // Taken, though not by xterm: it was copied on the way in.
    expect(replayKeyOnTerminal(el, ctrlC())).toBeTrue();
    await settle();
    expect(reached).toEqual([]);
    expect(written).toEqual(["from the page"]);
    // Nothing selected any more: the next one is xterm's.
    expect(replayKeyOnTerminal(el, ctrlC())).toBeTrue();
    expect(reached).toEqual(["c"]);
    unbind();
    terminal.state.selection = "again";
    expect(replayKeyOnTerminal(el, ctrlC())).toBeTrue();
    expect(reached).toEqual(["c", "c"]);
    expect(written).toEqual(["from the page"]);
  });
});

describe("replaying a key on xterm", () => {
  test("there is nothing to replay on before xterm has mounted", () => {
    const el = document.createElement("div");
    expect(replayKeyOnTerminal(el, ctrlC())).toBeFalse();
    expect(replayKeyOnTerminal(null, ctrlC())).toBeFalse();
  });

  test("a key xterm does not cancel is reported back as not taken", () => {
    const el = document.createElement("div");
    const field = document.createElement("textarea");
    field.className = "xterm-helper-textarea";
    el.append(field);
    document.body.append(el);
    expect(replayKeyOnTerminal(el, new KeyboardEvent("keydown", { key: "Dead", altKey: true, keyCode: 69 }))).toBeFalse();
    el.remove();
  });
});

describe("Ctrl+C at a complete terminal in 组字, beside the list", () => {
  /** The desk key rules over a bare pad, with a terminal whose selection the test sets. */
  function desk(selection: string) {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    resetInputMode();
    setComposeLive(false);
    setComposeDraft("");
    const root = document.createElement("div");
    const pad = document.createElement("div");
    root.append(pad);
    document.body.append(root);
    const terminal = terminalWith(selection);
    const sent: string[] = [];
    const unbind = bindFullTerminalDeskKeys(pad, {
      page: () => undefined,
      send: (key) => { sent.push(key); },
      focus: () => undefined,
      copySelection: () => copyTerminalSelection(terminal),
    });
    return { sent, terminal, done: () => { unbind(); root.remove(); happy.happyDOM.setWindowSize({ width: 390, height: 844 }); } };
  }

  const press = (): KeyboardEvent => {
    const event = ctrlC();
    document.body.dispatchEvent(event);
    return event;
  };

  test("off macOS it copies text dragged out of the terminal instead of interrupting", async () => {
    platform("Win32");
    const { sent, terminal, done } = desk("TypeScript checks passed");
    expect(press().defaultPrevented).toBeTrue();
    await settle();
    expect(written).toEqual(["TypeScript checks passed"]);
    expect(sent).toEqual([]);
    // The selection went with the copy: this one is the interrupt.
    expect(terminal.state.selection).toBe("");
    expect(press().defaultPrevented).toBeTrue();
    expect(sent).toEqual(["ctrl+c"]);
    done();
  });

  test("with nothing selected it interrupts, as it always did", () => {
    platform("Win32");
    const { sent, done } = desk("");
    expect(press().defaultPrevented).toBeTrue();
    expect(sent).toEqual(["ctrl+c"]);
    expect(written).toEqual([]);
    done();
  });

  test("on a Mac it interrupts over a selection too: Command+C is the copy there", () => {
    platform("MacIntel");
    const { sent, terminal, done } = desk("selected");
    expect(press().defaultPrevented).toBeTrue();
    expect(sent).toEqual(["ctrl+c"]);
    expect(written).toEqual([]);
    expect(terminal.state.selection).toBe("selected");
    done();
  });
});
