import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { batch } from "../../shared/model/domain-store";
import { setLang, t } from "../../lib/i18n";
import { ProtocolError } from "../../lib/protocol/client";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { resetComposeDrafts, bumpViewIncarnation } from "../../features/session/drafts/compose-drafts";
import { closePane, createSelectedTab, listSelectedWorktrees, renamePane, revokeSelf } from "../../features/operations/controller";
import { disposeFullTerminal } from "../../features/session/full-terminal/full-terminal";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import { submitTyped } from "../../features/session/guided/compose";
import type { AgentCard } from "../../lib/dashboard";
type LiveSession = import("../../lib/protocol/session-types").LiveSession;
const { setPhase, setNetworkOnline } = await import("../../features/connection/connection-store");
const { setScreen, currentScreen } = await import("../../app/navigation-store");
const { applyCapabilities, operationBusy } = await import("../../features/operations/capabilities-store");
const { attachLiveSession, liveSession, setCredential, credential } = await import("../../features/computers/catalog-store");
const { replaceAgentsFromSnapshot, resetDashboard } = await import("../../features/dashboard/catalog-store");
const { resetPaneView, selectPane, openPaneId } = await import("../../features/session/session-store");
const { setComposeDraft, composeDraft } = await import("../../features/session/compose-store");
const { setDefaultTermMode } = await import("../../features/settings/preferences-store");
const { setBoardReturn, resetBoardCatalog } = await import("../../features/board/layout-store");
const { clearNotice, visibleNotice, noticesStore } = await import("../../app/notices-store");
const { setOperationBusy } = await import("../../features/operations/capabilities-store");

type ProbeSession = LiveSession & { calls: string[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const card: AgentCard = {
  paneId: "p1", agent: "codex", status: "idle", hasAgent: true,
  workspaceLabel: "review", cwd: "/review", workspaceId: "w1", tabId: "t1",
};

function session(): ProbeSession {
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
  } as unknown as ProbeSession;
}

function boot(live: ProbeSession = session(), draft = ""): ProbeSession {
  batch(() => {
    setPhase("live"); setScreen("pane"); selectPane("p1"); resetPaneView();
    attachLiveSession(live);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "review", cwd: "/review" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "review" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/review", agent: "codex", agent_status: "idle" }],
    });
    setComposeDraft(draft);
    setDefaultTermMode("guided");
    setBoardReturn(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true, list_worktrees: true, open_worktree: true }, []);
  });
  bumpViewIncarnation();
  mountTestApp();
  commitTest();
  return live;
}

async function settle(update?: () => void) {
  await act(async () => { update?.(); await new Promise<void>((done) => window.setTimeout(done, 0)); });
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
  setNetworkOnline(true);
  setCredential(null);
});

afterEach(async () => {
  await act(async () => {
    closeTestDialogs();
    disposeFullTerminal();
    dropQueuedKeys();
    unmountTestApp();
    attachLiveSession(null);
    resetDashboard();
    resetBoardCatalog();
    clearNotice();
    setOperationBusy(false);
    setComposeDraft("");
    setScreen("home");
    await Promise.resolve();
  });
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
  const newField = appRoot().querySelector("textarea");
  await act(async () => { ack.resolve(undefined); await closing; });
  expect(old.calls).toEqual(["close:p1"]);
  expect(liveSession() === newer).toBeTrue();
  expect(openPaneId()).toBe("p1");
  expect(currentScreen()).toBe("pane");
  expect(appRoot().querySelector("textarea") === newField).toBeTrue();
  expect(composeDraft()).toBe("new computer draft");
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
  expect(openPaneId()).toBe("p1");
});

test("capability removed while React create-tab form is open prevents its mutation", async () => {
  const live = session();
  act(() => boot(live));
  let creating!: Promise<void>;
  act(() => { creating = createSelectedTab(card); });
  const form = document.querySelector<HTMLFormElement>("dialog.operation-modal form");
  if (!form) throw new Error("missing actual React create form");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: false }, []);
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
  const field = appRoot().querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { ack.resolve(undefined); await sending; });
  expect(old.calls).toEqual(["text"]);
  expect(newer.calls).toEqual([]);
  expect(composeDraft()).toBe("same draft");
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
  act(commitTest);
  await act(async () => { ack.reject(new ProtocolError("unknown_outcome", "uncertain")); await closing; });
  act(commitTest);
  expect(live.calls).toEqual(["close:p1", "snapshot"]);
  expect(openPaneId()).toBe("p1");
  expect(operationBusy()).toBeFalse();
});

for (const change of ["incarnation", "daemon"] as const) {
  test(`create form rejects an expired ${change} even when session and pane IDs still match`, async () => {
    const live = session();
    act(() => boot(live));
    let creating!: Promise<void>;
    act(() => { creating = createSelectedTab(card); });
    if (change === "incarnation") act(() => { bumpViewIncarnation(); commitTest(); });
    else setCredential({ daemonId: "another-daemon" } as NonNullable<ReturnType<typeof credential>>);
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
  act(() => { bumpViewIncarnation(); commitTest(); });
  expect(operationBusy()).toBeFalse();
  let creating!: Promise<void>;
  act(() => { creating = createSelectedTab(card); });
  const form = document.querySelector<HTMLFormElement>("dialog.operation-modal form")!;
  await settle(() => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  const newNotice = noticesStore.get().notice;
  expect(operationBusy()).toBeTrue();
  await act(async () => { oldAck.resolve(undefined); await closing; });
  expect(operationBusy()).toBeTrue();
  expect(noticesStore.get().notice === newNotice).toBeTrue();
  expect(openPaneId()).toBe("p1");
  await act(async () => { newAck.resolve({}); await creating; });
  expect(operationBusy()).toBeFalse();
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
  expect(openPaneId()).toBe("p1");
  expect(composeDraft()).toBe("new draft");
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
  expect(composeDraft()).toBe("repeat draft");
  expect(appRoot().querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("repeat draft");
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
  const newNotice = noticesStore.get().notice;
  await act(async () => { ack.reject(new ProtocolError("unknown_outcome", "old ambiguous result")); await sending; });
  expect(newer.calls).toEqual([]);
  expect(old.calls).toEqual(["text"]);
  expect(noticesStore.get().notice === newNotice).toBeTrue();
  expect(composeDraft()).toBe("new text");
});

for (const change of ["owner", "capability"] as const) {
  test(`worktree card rechecks ${change} at its actual React click`, async () => {
    const old = session();
    act(() => boot(old));
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, list_worktrees: true, open_worktree: true }, []);
    await act(async () => { await listSelectedWorktrees(); });
    const button = document.querySelector<HTMLButtonElement>("dialog .worktree-card")!;
    expect(Boolean(button)).toBeTrue();
    if (change === "owner") act(() => boot(session()));
    else applyCapabilities({ ...NO_OPERATION_CAPABILITIES, open_worktree: false }, []);
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
  setCredential({ daemonId: "old-daemon", deviceId: "old-device" } as NonNullable<ReturnType<typeof credential>>);
  let revoking!: Promise<void>;
  act(() => { revoking = revokeSelf(); });
  act(() => boot(session()));
  setCredential({ daemonId: "new-daemon", deviceId: "new-device" } as NonNullable<ReturnType<typeof credential>>);
  await confirm();
  await act(async () => { await revoking; });
  expect(old.calls).toEqual([]);
  expect(credential()?.deviceId).toBe("new-device");
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
  expect(visibleNotice()?.text).toBe(t("op.createdTab"));
  expect(visibleNotice()?.scope?.screen).toBe("pane");
  expect(operationBusy()).toBeFalse();
  let closing!: Promise<void>;
  act(() => { closing = closePane(card); });
  await confirm();
  await act(async () => { await closing; });
  expect(visibleNotice()?.text).toBe(t("op.closedPane"));
  expect(visibleNotice()?.scope?.screen).toBe("home");
  expect(operationBusy()).toBeFalse();
});
