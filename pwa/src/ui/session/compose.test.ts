import { describe, expect, test } from "bun:test";

const composeSource = await Bun.file(new URL("./compose.ts", import.meta.url)).text();

describe("compose send button", () => {
  /**
   * An empty draft used to submit a bare Enter, which answers whatever option
   * the TUI has highlighted. 发送 sits under the thumb on a phone, so that made
   * an accidental tap a blind confirmation.
  */
  test("is disabled while the draft is empty or only whitespace", () => {
    expect(composeSource).toContain("send.disabled = !state.composeLive && (submitBusy || !state.composeDraft.trim())");
    expect(composeSource).toContain("send.disabled = !state.composeDraft.trim()");
  });

  test("every path that changes the draft resyncs it", () => {
    for (const fn of ["clearComposeDraft", "insertNewline", "insertCompose", "setComposeText"]) {
      const start = composeSource.indexOf(`function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = composeSource.slice(start, composeSource.indexOf("\n}", start));
      expect(body).toContain("syncSendButton()");
    }
    const bind = composeSource.slice(composeSource.indexOf("function bindTermField("));
    expect(bind.match(/syncSendButton\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("tapping the buffer focuses the same field the keyboard types into", () => {
    expect(composeSource).toContain("export function focusCompose");
    expect(composeSource).toContain("组字 · 写完再发送");
    expect(composeSource).toContain('enterKeyHint = "enter"');
  });

  test("a deliberate Enter key press can still send a bare Enter", () => {
    const submit = composeSource.slice(composeSource.indexOf("export async function submitTyped"));
    expect(submit).toContain('queueKey("enter")');
  });

  test("submit binds Enter to the exact confirmed screen", () => {
    const submit = composeSource.slice(composeSource.indexOf("async function guardedSubmit"));
    expect(composeSource).toContain("const GUARDED_PANE_READ_LINES = 80");
    expect(submit).toContain('paneRead(paneId, GUARDED_PANE_READ_LINES, "text")');
    expect(submit).toContain('state.screen === "pane"');
    expect(submit).toContain("intent: \"submit\"");
    expect(submit).toContain("expected_signature: expectedSignature");
  });

  test("serializes submit taps so SendText cannot be duplicated", () => {
    const submit = composeSource.slice(composeSource.indexOf("export async function submitTyped"));
    expect(submit).toContain("submitBusy");
    expect(submit).toContain("finally");
    expect(composeSource).toContain("state.composeDraft === value");
    expect(composeSource).toContain('send.textContent = "发送中…"');
    expect(composeSource).toContain('send.setAttribute("aria-busy", "true")');
  });

  test("keeps delayed guarded submit automatic and visible to the user", () => {
    const guarded = composeSource.slice(composeSource.indexOf("async function guardedSubmit"));
    expect(guarded).toContain("SUBMIT_PENDING_NOTICE");
    expect(guarded).toContain("showStatus(SUBMIT_PENDING_NOTICE, true, noticeScope)");
    expect(guarded).toContain("retryRead:");
    expect(composeSource).toContain("确认后会自动按 Enter");
    expect(composeSource).not.toContain("可点按键垫上的 Enter");
  });

  test("batch and live input share the UTF-8 wire budget", () => {
    expect(composeSource).toContain("fitOperationPrompt(livePending + text)");
    expect(composeSource).toContain("fitOperationPrompt(input.value)");
    expect(composeSource).toContain("fitOperationPrompt(state.composeDraft + event.key)");
  });
});

describe("Tab stays a focus key outside the compose field", () => {
  /**
   * The pane opens with focus on the body, where the global keydown listener
   * treats every key as terminal input. Claiming Tab there left no way to reach
   * the back button, the menu, the keypad or the compose field by keyboard, and
   * each swallowed Tab was forwarded to the agent as a keystroke.
   */
  test("only an unshifted Tab typed into the field reaches the TUI", () => {
    const handler = composeSource.slice(composeSource.indexOf("export function handlePaneKey"));
    const guard = handler.slice(0, handler.indexOf('if (event.key === "Enter"'));
    expect(guard).toContain('event.key === "Tab" && (!fromField || event.shiftKey)');
  });

  test("the keypad still offers a literal Tab", async () => {
    const dock = await Bun.file(new URL("./dock.ts", import.meta.url)).text();
    expect(dock).toContain("SECONDARY_KEYS");
    expect(dock).toContain("TERTIARY_KEYS");
    const keypad = await Bun.file(new URL("../keypad.ts", import.meta.url)).text();
    expect(keypad).toContain('{ key: "tab", label: "Tab" }');
    expect(keypad).toContain('{ key: "up", label: "↑"');
  });
});

describe("slash command pad", () => {
  test("replaces the draft and never submits Enter on its own", () => {
    const setText = composeSource.slice(composeSource.indexOf("export function setComposeText"));
    const body = setText.slice(0, setText.indexOf("\n}\n\n"));
    expect(body).toContain("fitOperationPrompt(text)");
    expect(body).toContain("syncSendButton()");
    expect(body).not.toContain("submitTyped");
    expect(body).not.toContain("queueKey");
    expect(body).toContain("typeLive(text)");
  });
});

describe("compose live vs batch", () => {
  test("batch remains the default and is persisted explicitly", async () => {
    const stateSrc = await Bun.file(new URL("../../state.ts", import.meta.url)).text();
    const load = stateSrc.slice(stateSrc.indexOf("function loadComposeLive"));
    expect(load).toContain('getItem(COMPOSE_LIVE_KEY) === "1"');
    expect(composeSource).not.toContain("compose-modes");
    expect(composeSource).not.toContain("composeModePicker");
    expect(composeSource).toContain("export function composeLiveControl");
    expect(composeSource).toContain("syncComposeLiveControl");
    expect(composeSource).toContain('send.textContent = "Enter"');
    expect(composeSource).toContain("form.append(inputLabel, input, send)");
    expect(composeSource).toContain("实时 · 边打边进终端");
    const dock = await Bun.file(new URL("./dock.ts", import.meta.url)).text();
    expect(dock).not.toContain("composeLiveControl()");
    const settings = await Bun.file(new URL("../settings.ts", import.meta.url)).text();
    expect(settings).toContain("composeLiveControl()");
    expect(settings).toContain('set-title", "输入"');
    const menu = await Bun.file(new URL("../pane-menu.ts", import.meta.url)).text();
    expect(menu).toContain('menu-section-title", "输入"');
    expect(menu).toContain("setComposeLive");
  });

  test("live keystrokes send text without waiting for guarded Enter", () => {
    expect(composeSource).toContain("function typeLive(");
    expect(composeSource).toContain("takeLiveField(input)");
    expect(composeSource).toContain("session.sendText(paneId, text)");
    const liveEnterStart = composeSource.indexOf("async function submitLiveEnter");
    const liveEnter = composeSource.slice(liveEnterStart, composeSource.indexOf("export async function submitTyped"));
    expect(liveEnter).toContain("flushLiveInput()");
    expect(liveEnter).toContain('queueKey("enter")');
    expect(liveEnter).not.toContain("guardedSubmit");
    expect(composeSource).toContain("if (state.composeLive)");
    expect(composeSource).toContain("await submitLiveEnter()");
  });

  test("IME composition is held until the character is committed", () => {
    const bind = composeSource.slice(composeSource.indexOf("function bindTermField("));
    expect(bind).toContain("compositionstart");
    expect(bind).toContain("if (state.composeIME)");
    expect(bind).toContain("compositionend");
    expect(bind).toContain("takeLiveField(input)");
  });
});
