import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../../app/dom-root";
import type { LiveSession } from "../../../lib/protocol/client";
const { clearNotice, visibleNotice } = await import("../../../app/notices-store");
const { setScreen } = await import("../../../app/navigation-store");
const { setLang, t } = await import("../../../lib/i18n");
const { setNetworkOnline, setPhase } = await import("../../connection/connection-store");
const { applyRuntimeIdentity, runtimeIdentity } = await import("../../connection/runtime-store");
const { attachLiveSession } = await import("../../computers/catalog-store");
const { applySnapshot } = await import("../../dashboard/catalog-store");
const { composeDraft, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } = await import("../compose-store");
const { COMPOSE_ENTER_SENDS_KEY, setComposeEnterSends } = await import("../../settings/preferences-store");
const { selectPane } = await import("../session-store");
const { flushLiveInput, insertQuickCommand, insertSlashCommand } = await import("./compose");
const { withSlashCommand } = await import("../compose-keys");
const { dropQueuedKeys, flushKeys } = await import("./keys");
const { cancelStop, STOP_WATCH_MS } = await import("./session-stop");
const { SessionCompose } = await import("./session-compose");
const { STOP_ARM_MS } = await import("./compose-controls");

const restorer = new WorkspaceSnapshotRestorer();
let runtimeBefore = runtimeIdentity();
let enterSendsRaw: string | null = null;
let sentKeys: string[][] = [];
let sentText: string[] = [];

function seed(status: string): void {
  act(() => applySnapshot({
    workspaces: [{ workspace_id: "w", label: "project", cwd: "/repo/project" }],
    panes: [{ pane_id: "p1", workspace_id: "w", agent: "codex", agent_status: status, interactive_ready: true }],
  }));
}

function paint(includeBack = true): HTMLTextAreaElement {
  act(() => { renderReact(<SessionCompose includeBack={includeBack} />); });
  return appRoot().querySelector("textarea")!;
}

function sendButton(): HTMLButtonElement {
  return appRoot().querySelector<HTMLButtonElement>(".send-btn")!;
}

function key(input: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent {
  const view = input.ownerDocument.defaultView!;
  const event = new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { input.dispatchEvent(event); });
  return event;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  restorer.capture();
  runtimeBefore = runtimeIdentity();
  enterSendsRaw = localStorage.getItem(COMPOSE_ENTER_SENDS_KEY);
  sentKeys = [];
  sentText = [];
  act(() => {
    setLang("zh");
    setPhase("live");
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: runtimeBefore.herdHost, runtimeKind: "herdr" });
    attachLiveSession({
      isConnected: () => true,
      sendKeys: async (_paneId: string, keys: string[]) => { sentKeys.push(keys); },
      sendText: async (_paneId: string, text: string) => { sentText.push(text); },
    } as unknown as LiveSession);
    selectPane("p1");
    setScreen("pane");
  });
});

afterEach(async () => {
  await act(async () => { await flushLiveInput(); });
  unmountReact();
  cancelStop();
  dropQueuedKeys();
  act(() => {
    setComposeDraft("");
    setComposeLive(false);
    setComposeIME(false);
    setComposeFocused(false);
    setComposeEnterSends(false);
    restorer.restore();
    applyRuntimeIdentity(runtimeBefore);
    attachLiveSession(null);
    selectPane("");
    setScreen("home");
    clearNotice();
  });
  if (enterSendsRaw === null) localStorage.removeItem(COMPOSE_ENTER_SENDS_KEY);
  else localStorage.setItem(COMPOSE_ENTER_SENDS_KEY, enterSendsRaw);
  appRoot().replaceChildren();
});

describe("multi-line compose", () => {
  test("the phone keyboard's Return adds a line; only the send button sends", async () => {
    const input = paint(true);
    expect(input.getAttribute("enterkeyhint")).toBe("enter");
    input.value = "first line";
    act(() => { input.dispatchEvent(new (input.ownerDocument.defaultView!.Event)("input", { bubbles: true })); });
    const enter = key(input, { key: "Enter" });
    expect(enter.defaultPrevented).toBeFalse();
    await act(async () => { await flushKeys(); });
    expect(sentKeys).toEqual([]);
    expect(sentText).toEqual([]);
    expect(composeDraft()).toBe("first line");
  });

  test("the preference restores Return = send on the phone", async () => {
    act(() => { setComposeEnterSends(true); });
    const input = paint(true);
    expect(input.getAttribute("enterkeyhint")).toBe("send");
    const enter = key(input, { key: "Enter" });
    expect(enter.defaultPrevented).toBeTrue();
    await act(async () => { await flushKeys(); });
    expect(sentKeys).toEqual([["enter"]]);
  });

  test("the desktop field keeps Enter = send and Shift+Enter = newline", async () => {
    const input = paint(false);
    expect(key(input, { key: "Enter", shiftKey: true }).defaultPrevented).toBeFalse();
    expect(key(input, { key: "Enter" }).defaultPrevented).toBeTrue();
    await act(async () => { await flushKeys(); });
    expect(sentKeys).toEqual([["enter"]]);
  });

  test("live input keeps Enter for the terminal, with a live tag on the field", async () => {
    act(() => { setComposeLive(true); });
    const input = paint(true);
    expect(appRoot().querySelector(".compose-field.is-live .compose-live-tag")?.textContent).toBe(t("compose2.liveTag"));
    expect(key(input, { key: "Enter" }).defaultPrevented).toBeTrue();
  });

  test("more than three lines shows a faint line count", () => {
    act(() => { setComposeDraft("1\n2\n3"); });
    paint(false);
    expect(appRoot().querySelector(".compose-lines")).toBeNull();
    act(() => { setComposeDraft("1\n2\n3\n4"); });
    expect(appRoot().querySelector(".compose-lines")?.textContent).toBe("4 行");
  });

  test("a blurred multi-line draft folds; the unfold tap focuses with the caret restored", async () => {
    act(() => { setComposeDraft("one\ntwo\nthree"); });
    const input = paint(true);
    const field = appRoot().querySelector(".compose-field")!;
    expect(field.classList.contains("is-folded")).toBeTrue();
    expect(field.querySelector(".compose-lines")?.textContent).toBe("3 行");
    act(() => { input.focus(); });
    expect(field.classList.contains("is-folded")).toBeFalse();
    input.setSelectionRange(4, 4);
    act(() => { input.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(field.classList.contains("is-folded")).toBeTrue();
    const unfold = field.querySelector<HTMLButtonElement>(".compose-unfold")!;
    expect(unfold.getAttribute("aria-label")).toBe(t("compose2.unfoldAria", { n: 3 }));
    act(() => { unfold.click(); });
    expect(input.ownerDocument.activeElement).toBe(input);
    expect(field.classList.contains("is-folded")).toBeFalse();
    expect(input.selectionStart).toBe(4);
    // Sending still works while folded: the button is outside the fold.
    expect(sendButton().dataset.sendKind).toBe("send");
  });
});

describe("send button", () => {
  test("empty draft is ⏎ (Enter), text is 发送, and the field comes before the button", () => {
    paint(true);
    expect(sendButton().dataset.sendKind).toBe("enter");
    expect(sendButton().getAttribute("aria-label")).toBe(t("compose.enterAria"));
    act(() => { setComposeDraft("run tests"); });
    expect(sendButton().dataset.sendKind).toBe("send");
    expect(sendButton().textContent).toBe(t("compose.send"));
    const form = appRoot().querySelector(".dock-form")!;
    const order = [...form.children].map((child) => child.className);
    expect(order.indexOf("compose-field")).toBeLessThan(order.indexOf("send-slot"));
  });

  test("a working pane with an empty draft offers stop, which sends Esc and settles on the status", async () => {
    seed("working");
    paint(true);
    expect(sendButton().dataset.sendKind).toBe("stop");
    expect(sendButton().textContent).toBe(t("compose2.stop"));
    act(() => { sendButton().click(); });
    await act(async () => { await flushKeys(); });
    expect(sentKeys).toEqual([["esc"]]);
    expect(sendButton().dataset.sendKind).toBe("stopping");
    expect(sendButton().disabled).toBeTrue();
    seed("idle");
    expect(sendButton().dataset.sendKind).toBe("enter");
    expect(visibleNotice()?.text).toBe(t("compose2.stopped"));
  });

  test("still working after the watch window: force stop sends Ctrl+C once", async () => {
    seed("working");
    paint(true);
    const realSetTimeout = window.setTimeout;
    const pending: Array<() => void> = [];
    window.setTimeout = ((run: () => void, ms?: number) => {
      if (ms === STOP_WATCH_MS) { pending.push(run); return 0; }
      return realSetTimeout(run, ms);
    }) as typeof window.setTimeout;
    try {
      act(() => { sendButton().click(); });
      await act(async () => { await flushKeys(); });
      act(() => { pending.shift()?.(); });
      expect(sendButton().dataset.sendKind).toBe("force");
      expect(sendButton().textContent).toBe(t("compose2.force"));
      act(() => { sendButton().click(); });
      await act(async () => { await flushKeys(); });
      expect(sentKeys).toEqual([["esc"], ["ctrl+c"]]);
      act(() => { pending.shift()?.(); });
      expect(visibleNotice()?.text).toBe(t("compose2.stopFailed"));
      expect(sentKeys).toEqual([["esc"], ["ctrl+c"]]);
    } finally {
      window.setTimeout = realSetTimeout;
    }
  });

  test("typed text keeps 发送 while working; a long press stops instead", async () => {
    seed("working");
    act(() => { setComposeDraft("keep this draft"); });
    paint(true);
    const button = sendButton();
    expect(button.dataset.sendKind).toBe("send");
    const view = button.ownerDocument.defaultView!;
    const realSetTimeout = window.setTimeout;
    let longPress: (() => void) | null = null;
    window.setTimeout = ((run: () => void, ms?: number) => {
      if (ms === 500) { longPress = run; return 0; }
      return realSetTimeout(run, ms);
    }) as typeof window.setTimeout;
    try {
      act(() => { button.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true, cancelable: true })); });
    } finally {
      window.setTimeout = realSetTimeout;
    }
    act(() => { longPress!(); });
    act(() => { button.dispatchEvent(new view.PointerEvent("pointerup", { bubbles: true })); });
    act(() => { button.click(); });
    await act(async () => { await flushKeys(); });
    expect(sentKeys).toEqual([["esc"]]);
    expect(sentText).toEqual([]);
    expect(composeDraft()).toBe("keep this draft");
  });

  test("a stop that just replaced 发送 ignores the next tap until it arms", async () => {
    seed("working");
    act(() => { setComposeDraft("sent a moment ago"); });
    paint(true);
    expect(sendButton().dataset.sendKind).toBe("send");
    const realSetTimeout = window.setTimeout;
    let arm: (() => void) | null = null;
    window.setTimeout = ((run: () => void, ms?: number) => {
      if (ms === STOP_ARM_MS) { arm = run; return 0; }
      return realSetTimeout(run, ms);
    }) as typeof window.setTimeout;
    try {
      // The draft empties once the prompt goes out; the same slot turns into 停止.
      act(() => { setComposeDraft(""); });
    } finally {
      window.setTimeout = realSetTimeout;
    }
    expect(sendButton().dataset.sendKind).toBe("stop");
    // Same look as any stop (not greyed out), but the tap is ignored until armed.
    expect(sendButton().disabled).toBeFalse();
    expect(sendButton().getAttribute("aria-disabled")).toBe("true");
    act(() => { sendButton().click(); });
    await act(async () => { await flushKeys(); });
    expect(sentKeys).toEqual([]);
    act(() => { arm!(); });
    expect(sendButton().hasAttribute("aria-disabled")).toBeFalse();
    act(() => { sendButton().click(); });
    await act(async () => { await flushKeys(); });
    expect(sentKeys).toEqual([["esc"]]);
  });

  test("live input never offers stop", () => {
    seed("working");
    act(() => { setComposeLive(true); });
    paint(true);
    expect(sendButton().dataset.sendKind).toBe("enter");
  });
});

describe("command insertion", () => {
  test("a slash command goes before the draft and replaces an existing one", () => {
    expect(withSlashCommand("修复登录测试", "/goal")).toBe("/goal 修复登录测试");
    expect(withSlashCommand("/review 修复登录测试", "/goal ")).toBe("/goal 修复登录测试");
    expect(withSlashCommand("", "/clear")).toBe("/clear ");
    expect(withSlashCommand("/usr/bin 里的脚本", "/goal")).toBe("/goal /usr/bin 里的脚本");
  });

  test("insertSlashCommand keeps the rest of the draft in the field", () => {
    act(() => { setComposeDraft("写好的目标"); });
    const input = paint(true);
    act(() => { insertSlashCommand("/goal"); });
    expect(composeDraft()).toBe("/goal 写好的目标");
    expect(input.value).toBe("/goal 写好的目标");
    expect(sentKeys).toEqual([]);
  });

  test("insertQuickCommand goes in at the caret, or fills an empty draft", () => {
    const input = paint(true);
    act(() => { insertQuickCommand("run the tests"); });
    expect(composeDraft()).toBe("run the tests");
    act(() => { setComposeDraft("please  now"); });
    input.value = "please  now";
    input.setSelectionRange(7, 7);
    act(() => { insertQuickCommand("check"); });
    expect(composeDraft()).toBe("please check now");
    input.value = "abc";
    act(() => { setComposeDraft("abc"); });
    input.setSelectionRange(3, 3);
    act(() => { insertQuickCommand("def"); });
    expect(composeDraft()).toBe("abc def");
  });
});
