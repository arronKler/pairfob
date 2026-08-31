import { describe, expect, test } from "bun:test";

const composeSource = await Bun.file(new URL("./compose.ts", import.meta.url)).text();

describe("compose send button", () => {
  test("is a real Enter key and does not depend on parsed terminal text", () => {
    expect(composeSource).not.toContain("liftedPromptSelect");
    expect(composeSource).not.toContain("prompt-select");
    expect(composeSource).toContain("send.disabled = false");
    expect(composeSource).toContain('send.textContent = "Enter"');
    expect(composeSource).not.toContain('send.textContent = "发送"');
    expect(composeSource).not.toContain('t("compose.blockedAria")');
    expect(composeSource).toContain("void submitTyped(true)");
    const submit = composeSource.slice(composeSource.indexOf("export async function submitTyped"));
    expect(submit).toContain('if (allowBareEnter) queueKey("enter")');
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
    expect(composeSource).toContain('t("compose.batchPh")');
    expect(composeSource).toContain('enterKeyHint = "enter"');
    expect(composeSource).toContain("field.focus({ preventScroll: true })");
  });

  test("a deliberate Enter key press can still send a bare Enter", () => {
    const submit = composeSource.slice(composeSource.indexOf("export async function submitTyped"));
    expect(submit).toContain("allowBareEnter = false");
    expect(submit).toContain("if (allowBareEnter) queueKey");
    expect(composeSource).toContain("submitTyped(true)");
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
    expect(composeSource).toContain('t("compose.sending")');
    expect(composeSource).toContain('send.setAttribute("aria-busy", "true")');
  });

  test("keeps delayed guarded submit automatic and quiet unless it stalls", () => {
    const guarded = composeSource.slice(composeSource.indexOf("async function guardedSubmit"));
    expect(guarded).toContain("retryRead:");
    expect(guarded).not.toContain("showStatus(");
    expect(composeSource).not.toContain('t("compose.submitPending")');
    expect(composeSource).toContain('showError(stallNotice(), noticeScope)');
  });

  test("batch and live input share the UTF-8 wire budget", () => {
    expect(composeSource).toContain("fitOperationPrompt(queued + text)");
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
  test("batch remains the default and pane choices use separate persistence", async () => {
    const stateSrc = await Bun.file(new URL("../../state.ts", import.meta.url)).text();
    const load = stateSrc.slice(stateSrc.indexOf("function loadDefaultComposeLive"));
    expect(load).toContain('getItem(DEFAULT_COMPOSE_LIVE_KEY) === "1"');
    expect(stateSrc).toContain("export function loadPaneComposeLive");
    expect(stateSrc).toContain("export function setPaneComposeLive");
    expect(composeSource).not.toContain("compose-modes");
    expect(composeSource).not.toContain("composeModePicker");
    expect(composeSource).toContain("export function composeLiveControl");
    expect(composeSource).toContain("syncComposeLiveControl");
    expect(composeSource).toContain('send.textContent = "Enter"');
    expect(composeSource).toContain("form.append(inputLabel, liveStatus, input, send)");
    expect(composeSource).toContain('t("compose.livePh")');
    const dock = await Bun.file(new URL("./dock.ts", import.meta.url)).text();
    expect(dock).not.toContain("composeLiveControl()");
    const settings = await Bun.file(new URL("../settings.ts", import.meta.url)).text();
    expect(settings).toContain("composeLiveControl()");
    expect(settings).toContain('t("settings.input")');
    const menu = await Bun.file(new URL("../pane-menu.ts", import.meta.url)).text();
    expect(menu).toContain('t("menu.input")');
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

  test("keeps input behavior independent from the terminal display mode", () => {
    const switcher = composeSource.slice(composeSource.indexOf("export async function setComposeLive"));
    expect(switcher).toContain("setPaneComposeLive(paneId, on)");
    expect(switcher).toContain("state.paneId !== paneId || state.live !== session");
    expect(switcher).not.toContain("enterFullTerminal");
  });

  test("shows local pending text immediately and pipelines the ordered screen read", () => {
    expect(composeSource).toContain("new LiveInputPump");
    expect(composeSource).toContain('t("compose.pendingPh"');
    expect(composeSource).toContain('liveStatus.setAttribute("aria-live", "polite")');
    expect(composeSource).toContain("const request = session.sendText(paneId, text)");
    expect(composeSource).toContain("requestRead: () => { void requestPaneRefresh(); }");
    expect(composeSource).not.toContain("const LIVE_FLUSH_MS = 55");
  });

  test("Enter waits for all queued live text and does not replay an uncertain mutation", () => {
    const liveEnterStart = composeSource.indexOf("async function submitLiveEnter");
    const liveEnter = composeSource.slice(liveEnterStart, composeSource.indexOf("export async function submitTyped"));
    expect(liveEnter).toContain("if (!(await flushLiveInput())) return");
    expect(composeSource).toContain('error.code === "unknown_outcome"');
    expect(composeSource).toContain("? input.queuedText");
  });

  test("IME composition is held until the character is committed", () => {
    const bind = composeSource.slice(composeSource.indexOf("function bindTermField("));
    expect(bind).toContain("compositionstart");
    expect(bind).toContain("if (state.composeIME)");
    expect(bind).toContain("compositionend");
    expect(bind).toContain("takeLiveField(input)");
  });
});
