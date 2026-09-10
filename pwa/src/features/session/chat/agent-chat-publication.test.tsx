import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, createElement, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { appRoot } from "../../../app/dom-root";
import { appHost, type AppHost } from "../../../app/host";
import { attachLiveSession, liveSession } from "../../computers/catalog-store";
import { setScreen } from "../../../app/navigation-store";
import { openPaneId, resetPaneView, selectPane, setAgentChat } from "../session-store";
import { applyCapabilities, setOperationBusy } from "../../operations/capabilities-store";
import { applyTrace, chatSnapshot, chatStore, setTraceLoadState } from "./trace-store";
import { composeStore, setComposeDraft, setComposeFocused, setComposeIME } from "../compose-store";
import { clearNotice } from "../../../app/notices-store";
import { replaceAgentsFromSnapshot } from "../../dashboard/catalog-store";
import { setPhase } from "../../connection/connection-store";
import { setCredential } from "../../computers/catalog-store";
import { bumpViewIncarnation, resetComposeDrafts, switchComposeView } from "../drafts/compose-drafts";
import { cachedAgentTrace, clearAgentTraceCache } from "../../../lib/agent-trace-cache";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import type { LiveSession } from "../../../lib/protocol/client";
import { setLang } from "../../../lib/i18n";
import { mountTestApp, commitTest, unmountTestApp } from "../../../../test-support/react-harness";
import { bindSessionOwnerFromLive } from "../bind-live";
import { AgentChatPane } from "./agent-chat";
import { leaveAgentChat, patchAgentChat, refreshAgentTrace } from "./agent-chat-controller";

const handlers = { onBack() {}, onWorkspace() {}, onMenu() {}, onSwitch() {} };
const page = (text: string) => ({
  items: [{ type: "user" as const, text: "Question" }, { type: "assistant" as const, text }],
  nextCursor: "older",
  truncated: false,
});

let release: ((value: ReturnType<typeof page>) => void) | undefined;
let stopped: Array<() => void> = [];

/** Count real App host commits/requests (captured refs, restored at teardown). */
let committed = 0;
let requested = 0;
let hostRef: AppHost | null = null;
let realCommit: AppHost["commit"] | null = null;
let realRequestCommit: AppHost["requestCommit"] | null = null;

function watchHostCommits(): void {
  hostRef = appHost();
  committed = 0;
  requested = 0;
  realCommit = hostRef!.commit;
  realRequestCommit = hostRef!.requestCommit;
  hostRef!.commit = (options) => {
    committed += 1;
    realCommit!(options);
  };
  hostRef!.requestCommit = () => {
    requested += 1;
    realRequestCommit!();
  };
}

function restoreHostCommits(): void {
  if (!hostRef) return;
  if (realCommit) hostRef.commit = realCommit;
  if (realRequestCommit) hostRef.requestCommit = realRequestCommit;
  hostRef = null;
  realCommit = null;
  realRequestCommit = null;
}

let syncRoot: Root | null = null;

/**
 * The publication fixture mounts the chat pane synchronously, exactly like the
 * production screen root the original fixture drove (flushSync commit). The
 * generic harness's act-based renderReact defers the commit when mount() runs
 * inside a store subscriber during an outer act, which the nested-remount cases
 * here rely on; a fixture-local synchronous root on the same #app keeps those
 * cases' original mounting contract. StrictMode is preserved.
 */
function unmountSyncRoot(): void {
  act(() => {
    syncRoot?.unmount();
  });
  syncRoot = null;
}

function setStreamSize(stream: HTMLElement, height: number, top: number): void {
  Object.defineProperties(stream, {
    scrollHeight: { configurable: true, value: height },
    clientHeight: { configurable: true, value: 100 },
  });
  stream.scrollTop = top;
}

function mount(): void {
  bindSessionOwnerFromLive();
  // One root per test, reused across nested remounts: destroying + recreating it
  // on every mount runs the previous tree's retirement early, which masks the
  // key/owner seaming the nested-remount cases must keep exercising. The flush
  // render keeps the original synchronous mounting contract.
  syncRoot ??= createRoot(appRoot());
  flushSync(() => syncRoot!.render(createElement(StrictMode, null, createElement(AgentChatPane, { includeBack: true, handlers }))));
}

function baseLive(): LiveSession {
  return {
    isConnected: () => true,
    agentTrace: async () => page("ready"),
    promptAgent: async () => ({ outcome: "applied" }),
    sendKeys: async () => undefined,
  } as unknown as LiveSession;
}

function withLive(overrides: Partial<LiveSession>): void {
  attachLiveSession({ ...baseLive(), ...overrides } as unknown as LiveSession);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  await act(async () => unmountSyncRoot());
  resetComposeDrafts();
  clearAgentTraceCache();
  resetPaneView();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setCredential(null);
  setAgentChat(true);
  setTraceLoadState("ready");
  applyTrace({
    agentTraceItems: page("initial").items,
    agentTraceTail: 2,
    agentTraceSig: "initial",
    agentTraceBusy: false,
    agentTraceNext: "older",
    agentTraceFollow: true,
    agentTraceUnread: false,
  });
  setOperationBusy(false);
  setComposeDraft("draft p1");
  setComposeIME(false);
  setComposeFocused(false);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true, history: true }, []);
  // Per-pane workspace/tab snapshot so each agent keeps its own workspaceLabel
  // (p1 / p2, matching the original `workspaceLabel: paneId` input) with p1
  // selected; hasAgent/history/status/cwd are untouched.
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [
      { workspace_id: "w1", label: "p1" },
      { workspace_id: "w2", label: "p2" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "main" },
    ],
    panes: [
      { pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", agent: "codex", agent_status: "idle", history_available: true },
      { pane_id: "p2", workspace_id: "w2", tab_id: "w2:t1", cwd: "/repo", agent: "codex", agent_status: "idle", history_available: true },
    ],
  });
  attachLiveSession(baseLive());
  clearNotice();
  stopped = [];
  release = undefined;
  restoreHostCommits();
});

afterEach(async () => {
  for (const stop of stopped) stop();
  stopped = [];
  if (release) {
    await act(async () => { release!(page("cleanup")); await Promise.resolve(); await Promise.resolve(); });
    release = undefined;
  }
  // The same cleanup actions, in the original order, inside act: when a case
  // mounted the real App these publishes have a live subscriber (AgentCompose).
  await act(async () => {
    unmountSyncRoot();
    leaveAgentChat({ paint: false });
    resetComposeDrafts();
    clearAgentTraceCache();
    clearNotice();
    attachLiveSession(null);
    setScreen("home");
    selectPane("");
  });
  restoreHostCommits();
  unmountTestApp();
});

test("held trace request shows busy then clears both core snapshot and actual older button", async () => {
  withLive({ agentTrace: () => new Promise((resolve) => { release = resolve; }) });
  await act(async () => mount());
  let pending!: Promise<boolean>;
  await act(async () => { pending = refreshAgentTrace(true); });
  const during = {
    snapshot: chatSnapshot().agentTraceBusy,
    disabled: appRoot().querySelector<HTMLButtonElement>(".agent-older")!.disabled,
  };
  await act(async () => { release!(page("new")); release = undefined; await pending; });
  const after = {
    snapshot: chatSnapshot().agentTraceBusy,
    disabled: appRoot().querySelector<HTMLButtonElement>(".agent-older")!.disabled,
  };
  expect(during).toEqual({ snapshot: true, disabled: true });
  expect(after).toEqual({ snapshot: false, disabled: false });
});

test("jump-to-latest clears published unread and hides mounted jump button without global paint", async () => {
  applyTrace({ agentTraceFollow: false, agentTraceUnread: true });
  // Observe the no-global-paint contract through the real installed App host:
  // the mounted chat's update rides its own domain subscription, and the host
  // neither commits nor queued a commit during it.
  mountTestApp();
  commitTest();
  watchHostCommits();
  expect(appRoot().querySelector<HTMLButtonElement>(".agent-jump")!.hidden).toBeFalse();
  await act(async () => appRoot().querySelector<HTMLButtonElement>(".agent-jump")!.click());
  expect(chatSnapshot().agentTraceFollow).toBeTrue();
  expect(chatSnapshot().agentTraceUnread).toBeFalse();
  expect(appRoot().querySelector<HTMLButtonElement>(".agent-jump")!.hidden).toBeTrue();
  expect(committed).toBe(0);
  expect(requested).toBe(0);
});

test("typed chat publication updates mounted status without replacing composer", async () => {
  mountTestApp();
  commitTest();
  watchHostCommits();
  const input = appRoot().querySelector("textarea")!;
  await act(async () => { input.focus(); });
  await act(async () => applyTrace({ agentTraceTruncated: true, agentTraceNext: null }));
  expect(appRoot().querySelector<HTMLButtonElement>(".agent-older")!.hidden).toBeTrue();
  expect(appRoot().querySelector("textarea") === input).toBeTrue();
  expect(document.activeElement === input).toBeTrue();
  expect(committed).toBe(0);
  expect(requested).toBe(0);
});

test("refresh and jump publish chat through domain actions, not facade assigns", () => {
  const source = readFileSync(fileURLToPath(new URL("./agent-chat-controller.ts", import.meta.url)), "utf8");
  expect(source).not.toMatch(/state\.agentTrace/);
  expect(source).toContain("chatSnapshot()");
  const refresh = source.slice(
    source.indexOf("export async function refreshAgentTrace"),
    source.indexOf("export function enterAgentChat"),
  );
  const jump = source.slice(
    source.indexOf("export function jumpToLatest"),
    source.indexOf("export function sizeChatCompose"),
  );
  expect(refresh).toContain("setTraceBusy(true)");
  expect(refresh).toContain("setTraceBusy(false)");
  expect(refresh).not.toMatch(/state\.agentTraceBusy\s*=/);
  expect(refresh).toContain("retiredTrace(");
  const afterApply = refresh.slice(refresh.indexOf("applyTracePage(page, cursor !== null)"));
  const recheck = afterApply.indexOf("if (retiredTrace(request, session, paneId)) return false;");
  expect(recheck).toBeGreaterThan(-1);
  expect(afterApply.indexOf("rememberTrace(paneId)")).toBeGreaterThan(recheck);
  expect(jump).toContain("followTrace()");
  expect(jump).not.toMatch(/state\.agentTraceFollow\s*=/);
  expect(jump).not.toMatch(/state\.agentTraceUnread\s*=/);
  const patch = source.slice(
    source.indexOf("export function patchAgentChat"),
    source.indexOf("function paintPromptOwner"),
  );
  const beforePublish = patch.slice(0, patch.indexOf("publishAgentChatUI()"));
  expect(beforePublish).toContain("const stream = streamEl()");
  expect(beforePublish).toContain("liveSession()");
  expect(beforePublish).toContain("openPaneId()");
  expect(beforePublish).toContain("currentViewIncarnation()");
  const afterPublish = patch.slice(patch.indexOf("publishAgentChatUI()"));
  const ownerAt = afterPublish.indexOf("ownerIsCurrent(");
  const queryAt = afterPublish.indexOf("streamEl()");
  const scrollAt = afterPublish.indexOf("scrollTop");
  expect(ownerAt).toBeGreaterThan(-1);
  expect(queryAt).toBeGreaterThan(ownerAt);
  expect(scrollAt).toBeGreaterThan(queryAt);
  expect(afterPublish).toContain("painted !== stream");
  expect(afterPublish).toContain("currentViewIncarnation() !== incarnation");
});

test("a trace subscriber switching pane cannot cache its new pane transcript under the old pane", async () => {
  withLive({ agentTrace: () => new Promise((resolve) => { release = resolve; }) });
  await act(async () => mount());
  let transitioned = false;
  const stop = chatStore.subscribe(() => {
    if (transitioned || !chatStore.get().agentTraceItems.some((item) => item.text === "delivered old page")) return;
    transitioned = true;
    leaveAgentChat({ paint: false });
    switchComposeView(() => { selectPane("p2"); setAgentChat(true); });
    applyTrace({
      agentTraceItems: page("private p2 transcript").items,
      agentTraceNext: null,
      agentTraceLoadState: "ready",
      agentTraceBusy: false,
    });
  });
  let pending!: Promise<boolean>;
  await act(async () => { pending = refreshAgentTrace(true); });
  await act(async () => { release!(page("delivered old page")); release = undefined; await pending; });
  stop();
  const cached = cachedAgentTrace("p1");
  expect(transitioned).toBeTrue();
  expect(openPaneId()).toBe("p2");
  expect(cached?.items.some((item) => item.text === "private p2 transcript") ?? false).toBeFalse();
  expect(chatSnapshot().agentTraceItems.some((item) => item.text === "private p2 transcript")).toBeTrue();
});

test("owner switch during nested follow publication preserves the new pane reading position", async () => {
  withLive({ agentTrace: () => new Promise((resolve) => { release = resolve; }) });
  applyTrace({ agentTraceFollow: false, agentTraceUnread: true });
  await act(async () => mount());
  setStreamSize(appRoot().querySelector<HTMLElement>(".agent-stream")!, 1000, 900);
  let transitioned = false;
  let newStream: HTMLElement | null = null;
  stopped.push(chatStore.subscribe(() => {
    const snapshot = chatStore.get();
    if (transitioned || !snapshot.agentTraceFollow || !snapshot.agentTraceItems.some((item) => item.text === "delivered old page")) return;
    transitioned = true;
    leaveAgentChat({ paint: false });
    switchComposeView(() => { selectPane("p2"); setAgentChat(true); });
    applyTrace({
      agentTraceItems: page("new pane reading").items,
      agentTraceNext: null,
      agentTraceLoadState: "ready",
      agentTraceBusy: false,
      agentTraceFollow: false,
      agentTraceUnread: true,
    });
    mount();
    newStream = appRoot().querySelector<HTMLElement>(".agent-stream")!;
    setStreamSize(newStream, 2000, 140);
  }));
  let pending!: Promise<boolean>;
  await act(async () => { pending = refreshAgentTrace(); });
  let result = true;
  await act(async () => { release!({ ...page("delivered old page"), nextCursor: null }); release = undefined; result = await pending; });
  expect(transitioned).toBeTrue();
  expect(openPaneId()).toBe("p2");
  expect(result).toBeFalse();
  expect(chatSnapshot().agentTraceFollow).toBeFalse();
  expect(appRoot().querySelector(".agent-stream") === newStream).toBeTrue();
  expect(newStream?.scrollTop).toBe(140);
});

test("same owner still follows a successful current-tail refresh", async () => {
  withLive({ agentTrace: async () => ({ ...page("same owner delivered"), nextCursor: null }) });
  applyTrace({ agentTraceFollow: false, agentTraceUnread: true });
  await act(async () => mount());
  const stream = appRoot().querySelector<HTMLElement>(".agent-stream")!;
  setStreamSize(stream, 1000, 900);
  let result = false;
  await act(async () => { result = await refreshAgentTrace(); });
  expect(result).toBeTrue();
  expect(openPaneId()).toBe("p1");
  expect(chatSnapshot().agentTraceFollow).toBeTrue();
  expect(appRoot().querySelector(".agent-stream") === stream).toBeTrue();
  expect(stream.scrollTop).toBe(1000);
});

test("retirement during the initial busy publication prevents even the first read", async () => {
  let calls = 0;
  withLive({ agentTrace: async () => { calls++; return page("unexpected"); } });
  await act(async () => mount());
  let transitioned = false;
  stopped.push(chatStore.subscribe(() => {
    if (transitioned || !chatStore.get().agentTraceBusy) return;
    transitioned = true;
    leaveAgentChat({ paint: false });
    switchComposeView(() => { selectPane("p2"); setAgentChat(true); });
    applyTrace({
      agentTraceItems: page("new start owner").items,
      agentTraceLoadState: "ready",
      agentTraceBusy: false,
    });
  }));
  let result = true;
  await act(async () => { result = await refreshAgentTrace(); });
  expect(transitioned).toBeTrue();
  expect(result).toBeFalse();
  expect(calls).toBe(0);
  expect(chatSnapshot().agentTraceBusy).toBeFalse();
});

test("retirement at a tail-page publication prevents the automatic older-context read", async () => {
  let calls = 0;
  withLive({
    agentTrace: async () => {
      calls++;
      return { items: [{ type: "assistant" as const, text: "unowned tail" }], nextCursor: "needs-context", truncated: false };
    },
  });
  await act(async () => mount());
  let transitioned = false;
  stopped.push(chatStore.subscribe(() => {
    if (transitioned || !chatStore.get().agentTraceItems.some((item) => item.text === "unowned tail")) return;
    transitioned = true;
    leaveAgentChat({ paint: false });
    switchComposeView(() => { selectPane("p2"); setAgentChat(true); });
    applyTrace({
      agentTraceItems: page("new backfill owner").items,
      agentTraceNext: null,
      agentTraceLoadState: "ready",
      agentTraceBusy: false,
    });
  }));
  let result = true;
  await act(async () => { result = await refreshAgentTrace(); });
  expect(transitioned).toBeTrue();
  expect(result).toBeFalse();
  expect(calls).toBe(1);
  expect(chatSnapshot().agentTraceItems.some((item) => item.text === "new backfill owner")).toBeTrue();
});

function composeField(): HTMLTextAreaElement {
  const field = appRoot().querySelector<HTMLTextAreaElement>(".agent-dock textarea");
  if (!field) throw new Error("missing actual chat composer");
  return field;
}

function fire(field: HTMLElement, type: string): void {
  field.dispatchEvent(new window.Event(type, { bubbles: true }));
}

test("retirement during typed compositionend does not copy the retired IME field into the new pane", async () => {
  await act(async () => mount());
  const old = composeField();
  await act(async () => { fire(old, "compositionstart"); old.value = "private A IME"; fire(old, "input"); });
  let transitioned = false;
  let observed = "";
  let next: HTMLTextAreaElement | undefined;
  stopped.push(composeStore.subscribe(() => {
    if (transitioned || composeStore.get().composeIME) return;
    transitioned = true;
    observed = composeStore.get().composeDraft;
    switchComposeView(() => { selectPane("p2"); setAgentChat(true); });
    setComposeDraft("B draft");
    mount();
    next = composeField();
  }));
  await act(async () => { fire(old, "compositionend"); });
  expect(transitioned).toBeTrue();
  expect(openPaneId()).toBe("p2");
  expect(old.isConnected).toBeFalse();
  expect(composeField() === next).toBeTrue();
  expect(next?.value).toBe("B draft");
  expect(composeStore.get().composeDraft).toBe("B draft");
  expect(observed).toBe("private A IME");
});

test("a same session and pane remount during nested follow does not scroll the replacement stream", async () => {
  await act(async () => { applyTrace({ agentTraceFollow: false, agentTraceUnread: true }); mount(); });
  const old = appRoot().querySelector<HTMLElement>(".agent-stream")!;
  setStreamSize(old, 1000, 900);
  let next: HTMLElement | undefined;
  let transitioned = false;
  stopped.push(chatStore.subscribe(() => {
    if (transitioned || !chatStore.get().agentTraceFollow) return;
    transitioned = true;
    bumpViewIncarnation();
    applyTrace({ agentTraceFollow: false, agentTraceUnread: true });
    mount();
    next = appRoot().querySelector<HTMLElement>(".agent-stream")!;
    setStreamSize(next, 2000, 140);
  }));
  await act(async () => { expect(patchAgentChat({ follow: true })).toBeTrue(); });
  expect(transitioned).toBeTrue();
  expect(openPaneId()).toBe("p1");
  expect(old.isConnected).toBeFalse();
  expect(next === old).toBeFalse();
  expect(appRoot().querySelector(".agent-stream") === next).toBeTrue();
  expect(next?.scrollTop).toBe(140);
});