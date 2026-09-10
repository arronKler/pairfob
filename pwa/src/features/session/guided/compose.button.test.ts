import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { DaemonPreferenceState } from "../../../../test-support/preferences-daemon-restore";
import { ScalarPreferenceState } from "../../../../test-support/preferences-scalar-restore";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";

const { clearNotice } = await import("../../../app/notices-store");
const { appRoot } = await import("../../../app/dom-root");
const { setScreen } = await import("../../../app/navigation-store");
const { isFullTerminal, applyPaneRead, selectPane, setAgentChat, setFullTerminal, setPaneFollow, setPaneRow, setPaneUnread, setTermSelect } = await import("../session-store");
const { setComposeDraft, setComposeFocused, setComposeIME, composeDraft, composeLive, setComposeLive: writeComposeLive } = await import("../compose-store");
const { paneComposeLive, setDefaultComposeLive, setKeysExpanded, setPadKind, setPaneComposeLive, setTermWrap } = await import("../../settings/preferences-store");
const { setOperationBusy } = await import("../../operations/capabilities-store");
const { attachLiveSession } = await import("../../computers/catalog-store");
const { replaceAgentsFromSnapshot } = await import("../../dashboard/catalog-store");
const { setPhase } = await import("../../connection/connection-store");
const { setLang, t } = await import("../../../lib/i18n.ts");
const { flushLiveInput, handlePaneKey, sendPad, setComposeLive, submitTyped } = await import("./compose.ts");
const { dropQueuedKeys, flushKeys } = await import("./keys.ts");
const { SessionCompose } = await import("./session-compose.tsx");

function paint(): void {
  renderReact(createElement(SessionCompose, { includeBack: false }));
}

function mount(draft: string, live = false): HTMLButtonElement {
  setComposeDraft(draft);
  writeComposeLive(live);
  act(() => { paint(); });
  const button = appRoot().querySelector(".send-btn");
  if (!(button instanceof HTMLButtonElement)) throw new Error("missing compose Enter");
  return button;
}

// setPaneComposeLive / the preference setters persist to storage; capture before
// the baselines and restore after own teardown (no broad reset).
const daemonPrefState = new DaemonPreferenceState();
const scalarPrefState = new ScalarPreferenceState();
// replaceAgentsFromSnapshot({ panes: [] }) restores the original empty-agents
// input; it projects the board and prunes daemon maps + completionSeen raw, so
// WorkspaceSnapshotRestorer protects all those side-effects (capture before
// seed, restore after teardown).
const snapshotRestorer = new WorkspaceSnapshotRestorer();

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
  setLang("zh");
  daemonPrefState.capture();
  scalarPrefState.capture();
  snapshotRestorer.capture();
  setPhase("live");
  setScreen("home");
  selectPane("");
  applyPaneRead("", "");
  setFullTerminal(false);
  setAgentChat(false);
  setOperationBusy(false);
  setComposeDraft("");
  writeComposeLive(false);
  setComposeIME(false);
  setComposeFocused(false);
  setDefaultComposeLive(false);
  setKeysExpanded(false);
  setPadKind("keys");
  // Original baseline paneComposeLive: {}; explicitly clear the two panes this
  // fixture ever uses back to the default-false input (fallback is false, so
  // this equals the empty map for every original case).
  setPaneComposeLive("p1", false);
  setPaneComposeLive("p2", false);
  setTermSelect(false);
  setTermWrap(false);
  setPaneRow(null);
  setPaneFollow(true);
  setPaneUnread(false);
  attachLiveSession(null);
  replaceAgentsFromSnapshot({ panes: [] });
  clearNotice();
});

afterEach(async () => {
  await act(async () => { await flushLiveInput(); });
  unmountReact();
  dropQueuedKeys();
  setComposeDraft("");
  writeComposeLive(false);
  setDefaultComposeLive(false);
  attachLiveSession(null);
  selectPane("");
  applyPaneRead("", "");
  setScreen("home");
  clearNotice();
  scalarPrefState.restore();
  daemonPrefState.restore();
  snapshotRestorer.restore();
  appRoot().replaceChildren();
});

describe("compose trailing Enter", () => {
  const lifted = [
    "╭──────────────────────────────────────────────────╮",
    "│ Edit file                                        │",
    "│                                                  │",
    "│ Do you want to make this edit to config.ts?      │",
    "│ ❯ 1. Yes                                         │",
    "│   2. Yes, allow all edits this session           │",
    "│   3. No, and tell Claude what to do differently  │",
    "╰──────────────────────────────────────────────────╯",
    "",
    "  esc to interrupt · ? for shortcuts",
  ].join("\n");

  test("empty Enter stays available on ordinary and confirmation screens", () => {
    applyPaneRead("Delete everything? [Y/n]", "");
    const open = mount("");
    expect(open.disabled).toBe(false);
    expect(open.textContent).toBe("Enter");
    expect(open.getAttribute("aria-label")).toBe("向终端发送 Enter");

    applyPaneRead(lifted, "");
    const prompt = mount("");
    expect(prompt.disabled).toBe(false);
    expect(prompt.getAttribute("aria-label")).toBe("向终端发送 Enter");
    expect(mount("run tests").disabled).toBe(false);
  });

  test("live mode keeps an empty trailing Enter", () => {
    const button = mount("", true);
    expect(button.textContent).toBe("Enter");
    expect(button.disabled).toBe(false);
  });

  test("selecting live input stays in the guided view and belongs only to the active pane", async () => {
    selectPane("p1");
    setScreen("pane");
    attachLiveSession({ isConnected: () => true } as never);
    mount("");

    await act(async () => { await setComposeLive(true); });

    expect(composeLive()).toBeTrue();
    expect(isFullTerminal()).toBeFalse();
    expect(paneComposeLive("p1")).toBeTrue();
    expect(paneComposeLive("p2")).toBeFalse();
  });

  test("a delayed mode flush cannot overwrite the next pane's input mode", async () => {
    let finishSend!: () => void;
    selectPane("p1");
    setScreen("pane");
    attachLiveSession({
      isConnected: () => true,
      sendText: () => new Promise<void>((resolve) => { finishSend = resolve; }),
    } as never);
    mount("", true);
    const input = appRoot().querySelector("textarea");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing live compose");
    const view = appRoot().ownerDocument.defaultView!;
    act(() => {
      input.value = "one";
      input.dispatchEvent(new view.Event("input", { bubbles: true }));
    });

    let changing!: Promise<void>;
    act(() => { changing = setComposeLive(false); });
    await act(async () => { await Promise.resolve(); });
    selectPane("p2");
    writeComposeLive(true);
    setPaneComposeLive("p2", true);
    await act(async () => { finishSend(); await changing; });

    expect(composeLive()).toBeTrue();
    expect(paneComposeLive("p1")).toBeFalse();
    expect(paneComposeLive("p2")).toBeTrue();
  });

  test("live input is visible locally before the network flush", async () => {
    const sent: string[] = [];
    selectPane("p1");
    setScreen("home");
    attachLiveSession({
      isConnected: () => true,
      sendText: async (_paneId: string, text: string) => {
        sent.push(text);
      },
    } as never);
    mount("", true);
    const input = appRoot().querySelector("textarea");
    const form = appRoot().querySelector(".dock-form");
    if (!(input instanceof HTMLTextAreaElement) || !(form instanceof HTMLElement)) throw new Error("missing live compose");
    const view = appRoot().ownerDocument.defaultView!;

    act(() => {
      input.value = "hello";
      input.dispatchEvent(new view.Event("input", { bubbles: true }));
    });

    expect(input.value).toBe("");
    expect(input.placeholder).toBe("本机待回显 · hello");
    expect(form.classList.contains("live-pending")).toBeTrue();
    expect(form.querySelector(".live-input-status")?.textContent).toBe(t("compose.pendingStatus", { n: 5 }));
    expect(sent).toEqual([]);

    expect(await act(() => flushLiveInput())).toBeTrue();
    expect(sent).toEqual(["hello"]);
    expect(input.placeholder).toBe("实时 · 边打边进终端");
  });

  test("a failed live mutation pauses live mode and restores text for deliberate retry", async () => {
    selectPane("p1");
    setScreen("home");
    attachLiveSession({
      isConnected: () => true,
      sendText: async () => { throw new Error("not sent"); },
    } as never);
    mount("", true);
    const input = appRoot().querySelector("textarea");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing live compose");
    const view = appRoot().ownerDocument.defaultView!;
    act(() => {
      input.value = "retry me";
      input.dispatchEvent(new view.Event("input", { bubbles: true }));
    });

    expect(await act(() => flushLiveInput())).toBeFalse();
    expect(composeLive()).toBeFalse();
    expect(composeDraft()).toBe("retry me");
    expect(input.value).toBe("retry me");
  });

  test("a deliberate keyboard Enter remains available outside the trailing button", async () => {
    const sent: string[][] = [];
    selectPane("p1");
    setScreen("home");
    attachLiveSession({
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as never);
    mount("");

    const view = appRoot().ownerDocument.defaultView!;
    const event = new view.KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    await act(async () => { handlePaneKey(event, true); await flushKeys(); });

    expect(event.defaultPrevented).toBe(true);
    expect(sent).toEqual([["enter"]]);
  });

  test("the trailing button and keypad both send a bare Enter", async () => {
    const sent: string[][] = [];
    selectPane("p1");
    attachLiveSession({
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as never);
    const button = mount("");

    await act(async () => { await submitTyped(true); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);

    sent.length = 0;
    await act(() => { button.click(); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);

    sent.length = 0;
    await act(async () => { await sendPad("enter"); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);
  });

  test("a confirmation screen receives the same deliberate Enter as any TUI", async () => {
    const sent: string[][] = [];
    selectPane("p1");
    applyPaneRead(lifted, "");
    attachLiveSession({
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => {
        sent.push(keys);
      },
    } as never);
    mount("");

    await act(async () => { await submitTyped(true); });
    await act(async () => { await flushKeys(); });
    expect(sent).toEqual([["enter"]]);
  });
});