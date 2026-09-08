import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { app, state } from "../../state";
import { setRenderer } from "../../paint";
import { setLang, t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/client";
import { resetComposeDrafts, bumpViewIncarnation } from "../../compose-drafts";
import { closePane, createSelectedTab, listSelectedWorktrees, renamePane, revokeSelf } from "../../live-operations";
import { disposeFullTerminal } from "../full-terminal";
import { dropQueuedKeys } from "../session/keys";
import { submitTyped } from "../session/compose";
import { renderApp } from "./app-screen";
import { leaveReactScreen } from "./root";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const card = { paneId: "p1", agent: "codex", status: "idle", hasAgent: true,
  workspaceLabel: "review", cwd: "/review", workspaceId: "w1", tabId: "t1" };
function session() {
  const calls: string[] = [];
  return {
    calls,
    isConnected: () => true,
    snapshot: async () => { calls.push("snapshot"); return { panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "codex" }] }; },
    paneRead: async () => ({ text: "ready", hash: "1".repeat(64) }),
    closePane: async (_id: string): Promise<unknown> => { calls.push("close:p1"); },
    createTab: async (_input: unknown): Promise<unknown> => { calls.push("create"); return {}; },
    sendText: async (_id: string, _text: string): Promise<unknown> => { calls.push("text"); },
    sendKeys: async (_id: string, _keys: string[]): Promise<unknown> => { calls.push("keys"); },
    renamePane: async (_id: string, _label: string | null) => { calls.push("rename"); },
    revokeDevice: async (_id: string) => { calls.push("revoke"); },
    listWorktrees: async () => {
      calls.push("list-worktrees");
      return { worktrees: [{ path: "/review/branch", label: "Branch", branch: "branch", is_bare: false,
        is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: null }] };
    },
    openWorktree: async (_input: unknown) => { calls.push("open-worktree"); return {}; },
  };
}
function boot(live = session(), draft = "") {
  Object.assign(state, { phase: "live", screen: "pane", paneId: "p1", live,
    agents: [{ ...card }], paneText: "ready", paneHash: "1".repeat(64), fullTerminal: false,
    agentChat: false, composeLive: false, composeDraft: draft, termSelect: false,
    networkOnline: true, operationBusy: false });
  state.operationCapabilities = { ...state.operationCapabilities, create_tab: true };
  bumpViewIncarnation();
  renderApp();
  return live;
}
async function settle(update?: () => void) {
  await act(async () => { update?.(); await new Promise<void>(done => window.setTimeout(done, 0)); });
}
async function confirm() {
  const button = document.querySelector<HTMLButtonElement>("dialog[data-react-modal] .btn-danger");
  if (!button) throw new Error("missing actual React confirmation");
  await settle(() => button.click());
}
beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetComposeDrafts();
  state.credential = null;
  state.composeIME = false;
  state.composeFocused = false;
  state.paneTermModes = {};
  state.paneComposeLive = {};
  state.defaultTermMode = "guided";
  state.boardReturn = false;
  setRenderer(renderApp);
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); disposeFullTerminal(); leaveReactScreen(); await Promise.resolve(); });
  dropQueuedKeys();
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.operationBusy = false;
  state.composeDraft = "";
  setRenderer(() => {});
});

test("held old-computer close success cannot clear a new computer's same-id pane", async () => {
  const ack = deferred<unknown>();
  const old = session();
  old.closePane = async () => { old.calls.push("close:p1"); return ack.promise; };
  act(() => boot(old));
  let closing!: Promise<void>;
  act(() => { closing = closePane(card); });
  await confirm();
  expect(old.calls).toEqual(["close:p1"]);
  const newer = session();
  act(() => boot(newer, "new computer draft"));
  const newField = app.querySelector("textarea");
  await act(async () => { ack.resolve(undefined); await closing; });
  expect(old.calls).toEqual(["close:p1"]);
  expect(state.live === newer).toBeTrue();
  expect(state.paneId).toBe("p1");
  expect(state.screen).toBe("pane");
  expect(app.querySelector("textarea") === newField).toBeTrue();
  expect(state.composeDraft).toBe("new computer draft");
});

test("confirmation opened on old computer cannot dispatch a mutation after computer switch", async () => {
  const old = session();
  act(() => boot(old));
  let closing!: Promise<void>;
  act(() => { closing = closePane(card); });
  const newer = session();
  act(() => boot(newer));
  await confirm();
  await act(async () => { await closing; });
  expect(old.calls).toEqual([]);
  expect(newer.calls).toEqual([]);
  expect(state.paneId).toBe("p1");
});

test("capability removed while React create-tab form is open prevents its mutation", async () => {
  const live = session();
  act(() => boot(live));
  let creating!: Promise<void>;
  act(() => { creating = createSelectedTab(card); });
  const form = document.querySelector<HTMLFormElement>("dialog.operation-modal form");
  if (!form) throw new Error("missing actual React create form");
  state.operationCapabilities = { ...state.operationCapabilities, create_tab: false };
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await creating;
  });
  expect(live.calls).toEqual([]);
});

test("held guided SendText success cannot erase equal text in a newer owner draft", async () => {
  const ack = deferred<unknown>();
  const old = session();
  old.sendText = async () => { old.calls.push("text"); return ack.promise; };
  act(() => boot(old, "same draft"));
  let sending!: Promise<void>;
  act(() => { sending = submitTyped(true); });
  await settle();
  expect(old.calls).toEqual(["text"]);
  const newer = session();
  act(() => boot(newer, "same draft"));
  const field = app.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { ack.resolve(undefined); await sending; });
  expect(old.calls).toEqual(["text"]);
  expect(newer.calls).toEqual([]);
  expect(state.composeDraft).toBe("same draft");
  expect(field.value).toBe("same draft");
});

test("unknown close outcome only reconciles once and never replays the mutation", async () => {
  const ack = deferred<unknown>();
  const live = session();
  live.closePane = async () => { live.calls.push("close:p1"); return ack.promise; };
  act(() => boot(live));
  let closing!: Promise<void>;
  act(() => { closing = closePane(card); });
  await confirm();
  act(renderApp);
  await act(async () => { ack.reject(new ProtocolError("unknown_outcome", "uncertain")); await closing; });
  act(renderApp);
  expect(live.calls).toEqual(["close:p1", "snapshot"]);
  expect(state.paneId).toBe("p1");
  expect(state.operationBusy).toBeFalse();
});

for (const change of ["incarnation", "daemon"] as const) {
  test(`create form rejects an expired ${change} even when session and pane IDs still match`, async () => {
    const live = session();
    act(() => boot(live));
    let creating!: Promise<void>;
    act(() => { creating = createSelectedTab(card); });
    if (change === "incarnation") act(() => { bumpViewIncarnation(); renderApp(); });
    else state.credential = { daemonId: "another-daemon" } as NonNullable<typeof state.credential>;
    const form = document.querySelector<HTMLFormElement>("dialog.operation-modal form")!;
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await creating;
    });
    expect(live.calls).toEqual([]);
  });
}

test("late old-view operation cannot release a newer operation's busy lock or pending notice", async () => {
  const oldAck = deferred<unknown>();
  const newAck = deferred<unknown>();
  const live = session();
  live.closePane = async () => { live.calls.push("close:p1"); return oldAck.promise; };
  live.createTab = async () => { live.calls.push("create"); return newAck.promise; };
  act(() => boot(live));
  let closing!: Promise<void>;
  act(() => { closing = closePane(card); });
  await confirm();
  act(() => { bumpViewIncarnation(); renderApp(); });
  expect(state.operationBusy).toBeFalse();
  let creating!: Promise<void>;
  act(() => { creating = createSelectedTab(card); });
  const form = document.querySelector<HTMLFormElement>("dialog.operation-modal form")!;
  await settle(() => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  const newNotice = state.notice;
  expect(state.operationBusy).toBeTrue();
  await act(async () => { oldAck.resolve(undefined); await closing; });
  expect(state.operationBusy).toBeTrue();
  expect(state.notice === newNotice).toBeTrue();
  expect(state.paneId).toBe("p1");
  await act(async () => { newAck.resolve({}); await creating; });
  expect(state.operationBusy).toBeFalse();
  expect(live.calls).toEqual(["close:p1", "create", "snapshot"]);
});

test("late create success never opens its returned pane in a replacement computer", async () => {
  const ack = deferred<unknown>();
  const old = session();
  old.createTab = async () => { old.calls.push("create"); return ack.promise; };
  act(() => boot(old));
  let creating!: Promise<void>;
  act(() => { creating = createSelectedTab(card); });
  const form = document.querySelector<HTMLFormElement>("dialog.operation-modal form")!;
  await settle(() => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  const newer = session();
  act(() => boot(newer, "new draft"));
  await act(async () => { ack.resolve({ pane_id: "p2" }); await creating; });
  expect(newer.calls).toEqual([]);
  expect(old.calls).toEqual(["create"]);
  expect(state.paneId).toBe("p1");
  expect(state.composeDraft).toBe("new draft");
});

test("held guided SendText success cannot erase a same-session same-pane re-entry draft", async () => {
  const ack = deferred<unknown>();
  const live = session();
  live.sendText = async () => { live.calls.push("text"); return ack.promise; };
  act(() => boot(live, "repeat draft"));
  let sending!: Promise<void>;
  act(() => { sending = submitTyped(true); });
  await settle();
  act(() => boot(live, "repeat draft"));
  await act(async () => { ack.resolve(undefined); await sending; });
  expect(live.calls).toEqual(["text"]);
  expect(state.composeDraft).toBe("repeat draft");
  expect(app.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("repeat draft");
});

test("late guided send failure keeps the replacement view's notice and does not replay text", async () => {
  const ack = deferred<unknown>();
  const old = session();
  old.sendText = async () => { old.calls.push("text"); return ack.promise; };
  act(() => boot(old, "old text"));
  let sending!: Promise<void>;
  act(() => { sending = submitTyped(true); });
  await settle();
  const newer = session();
  act(() => boot(newer, "new text"));
  const newNotice = state.notice;
  await act(async () => { ack.reject(new ProtocolError("unknown_outcome", "old ambiguous result")); await sending; });
  expect(newer.calls).toEqual([]);
  expect(old.calls).toEqual(["text"]);
  expect(state.notice === newNotice).toBeTrue();
  expect(state.composeDraft).toBe("new text");
});

for (const change of ["owner", "capability"] as const) {
  test(`worktree card rechecks ${change} at its actual React click`, async () => {
    const old = session();
    act(() => boot(old));
    state.operationCapabilities = { ...state.operationCapabilities, list_worktrees: true, open_worktree: true };
    await act(async () => { await listSelectedWorktrees(); });
    const button = document.querySelector<HTMLButtonElement>("dialog .worktree-card")!;
    expect(Boolean(button)).toBeTrue();
    if (change === "owner") act(() => boot(session()));
    else state.operationCapabilities = { ...state.operationCapabilities, open_worktree: false };
    await settle(() => button.click());
    expect(old.calls).toEqual(["list-worktrees"]);
  });
}

test("retired rename and unpair dialogs cannot mutate a cached old session", async () => {
  const old = session();
  act(() => boot(old));
  let renaming!: Promise<void>;
  act(() => { renaming = renamePane(card); });
  act(() => boot(session()));
  const form = document.querySelector<HTMLFormElement>("dialog form")!;
  await act(async () => {
    form.querySelector("input")!.value = "new label";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await renaming;
  });
  act(() => boot(old));
  state.credential = { daemonId: "old-daemon", deviceId: "old-device" } as NonNullable<typeof state.credential>;
  let revoking!: Promise<void>;
  act(() => { revoking = revokeSelf(); });
  act(() => boot(session()));
  state.credential = { daemonId: "new-daemon", deviceId: "new-device" } as NonNullable<typeof state.credential>;
  await confirm();
  await act(async () => { await revoking; });
  expect(old.calls).toEqual([]);
  expect(state.credential?.deviceId).toBe("new-device");
});

test("an operation's own create and close navigation still shows the successful result", async () => {
  const live = session();
  live.createTab = async () => { live.calls.push("create"); return { pane_id: "p1" }; };
  act(() => boot(live));
  let creating!: Promise<void>;
  act(() => { creating = createSelectedTab(card); });
  await act(async () => {
    document.querySelector<HTMLFormElement>("dialog.operation-modal form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await creating;
  });
  expect(state.notice?.text).toBe(t("op.createdTab"));
  expect(state.notice?.scope?.screen).toBe("pane");
  expect(state.operationBusy).toBeFalse();
  let closing!: Promise<void>;
  act(() => { closing = closePane(card); });
  await confirm();
  await act(async () => { await closing; });
  expect(state.notice?.text).toBe(t("op.closedPane"));
  expect(state.notice?.scope?.screen).toBe("home");
  expect(state.operationBusy).toBeFalse();
});
