import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { resetComposeDrafts } from "../drafts/compose-drafts";
import { cachedAgentTrace, clearAgentTraceCache } from "../../../lib/agent-trace-cache";
import { setLang } from "../../../lib/i18n";
import type { LiveSession } from "../../../lib/protocol/client";
import { NO_OPERATION_CAPABILITIES, type AgentTraceItem, type AgentTracePage } from "../../../lib/operations";
import { applyTrace, chatSnapshot, resetTrace, setPendingTurn, setTraceLoadState } from "./trace-store";
import { leaveAgentChat, refreshAgentTrace } from "./agent-chat-controller";
import { applyCapabilities, setOperationBusy } from "../../operations/capabilities-store";
import { clearNotice } from "../../../app/notices-store";
import { attachLiveSession, setCredential } from "../../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../../dashboard/catalog-store";
import { resetPaneView, selectPane, setAgentChat } from "../session-store";
import { setPhase } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { AgentChatPane } from "./agent-chat";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";

const handlers = { onBack() {}, onWorkspace() {}, onMenu() {}, onSwitch() {} };
const ask = (text: string): AgentTraceItem => ({ type: "user", text });
const reply = (text: string): AgentTraceItem => ({ type: "assistant", text });

type Call = { cursor: string | null; sessionIndex: number | undefined };
let calls: Call[] = [];
/** Pages by `${sessionIndex ?? 0}|${cursor}`. */
let pages: Record<string, AgentTracePage> = {};

function serve(): void {
  calls = [];
  attachLiveSession({
    isConnected: () => true,
    agentTrace: async (_pane: string, cursor: string | null, _limit: number, sessionIndex?: number) => {
      calls.push({ cursor, sessionIndex });
      const page = pages[`${sessionIndex ?? 0}|${cursor}`];
      if (!page) throw new Error(`no page for ${sessionIndex}|${cursor}`);
      return page;
    },
    promptAgent: async () => ({ outcome: "applied" }),
    sendKeys: async () => undefined,
  } as unknown as LiveSession);
}

function page(items: AgentTraceItem[], nextCursor: string | null, hasEarlierSession: boolean): AgentTracePage {
  return { items, nextCursor, truncated: false, hasEarlierSession };
}

const refresh = (older = false) => act(async () => { await refreshAgentTrace(older); });
const enableSessions = (on: boolean) =>
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true, history: true, agent_trace_sessions: on }, []);

beforeEach(async () => {
  await resetTestDOM();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
  globals.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
  resetComposeDrafts();
  clearAgentTraceCache();
  resetPaneView();
  setLang("en");
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setCredential(null);
  setAgentChat(true);
  setTraceLoadState("ready");
  setOperationBusy(false);
  enableSessions(true);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{
      pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/review",
      agent: "pi", agent_status: "idle", history_available: false,
    }],
  });
  clearNotice();
  bindSessionOwnerFromLive();
  pages = {};
  act(() => renderReact(<AgentChatPane includeBack handlers={handlers} />));
  applyTrace({ agentTracePending: "", agentTraceNote: "" });
});
afterEach(() => {
  act(unmountReact);
  leaveAgentChat({ paint: false, rememberGuided: false });
  resetTrace();
  resetComposeDrafts();
  clearAgentTraceCache();
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
});

test("without the capability no request carries session_index; with it every current-session request carries session_index 0", async () => {
  pages["0|null"] = page([ask("a"), reply("b")], null, true);
  enableSessions(false);
  serve();
  await refresh();
  await refresh(true);
  expect(calls).toEqual([{ cursor: null, sessionIndex: undefined }]);
  enableSessions(true);
  serve();
  await refresh();
  expect(calls).toEqual([{ cursor: null, sessionIndex: 0 }]);
});

test("at the top of a session the older request goes to the next session index, paging keeps its index", async () => {
  pages["0|null"] = page([ask("cur"), reply("c")], null, true);
  pages["1|null"] = page([ask("s1"), reply("one")], "c1", true);
  pages["1|c1"] = page([ask("s1 first"), reply("zero")], null, true);
  pages["2|null"] = page([ask("s2"), reply("two")], null, false);
  serve();
  await refresh();
  await refresh(true);
  await refresh(true);
  await refresh(true);
  expect(calls).toEqual([
    { cursor: null, sessionIndex: 0 },
    { cursor: null, sessionIndex: 1 },
    { cursor: "c1", sessionIndex: 1 },
    { cursor: null, sessionIndex: 2 },
  ]);
  expect(chatSnapshot().agentTraceOlder.map((segment) => segment.index)).toEqual([1, 2]);
  expect(chatSnapshot().agentTraceOlder[0].items.map((item) => item.text)).toEqual(["s1 first", "zero", "s1", "one"]);
});

test("a page without hasEarlierSession and without a cursor makes no further older request", async () => {
  pages["0|null"] = page([ask("a"), reply("b")], null, false);
  serve();
  await refresh();
  await refresh(true);
  expect(calls).toHaveLength(1);
  expect(chatSnapshot().agentTraceOlder).toEqual([]);
});

test("a new current page keeps the loaded older segments, and equal text in two sessions stays two items", async () => {
  pages["0|null"] = page([ask("same"), reply("r")], null, true);
  pages["1|null"] = page([ask("same"), reply("r")], null, false);
  serve();
  await refresh();
  await refresh(true);
  pages["0|null"] = page([ask("same"), reply("r"), reply("more")], null, true);
  await refresh();
  expect(chatSnapshot().agentTraceItems.map((item) => item.text)).toEqual(["same", "r", "more"]);
  expect(chatSnapshot().agentTraceOlder).toHaveLength(1);
  expect(chatSnapshot().agentTraceOlder[0].items.map((item) => item.text)).toEqual(["same", "r"]);
  pages["0|null"] = page([ask("other")], "cur-cursor", true);
  await refresh();
  expect(chatSnapshot().agentTraceOlder).toHaveLength(1);
});

test("a line in the current session appears there and pending pairing ignores older segments", async () => {
  pages["0|null"] = page([ask("cur"), reply("c")], null, true);
  pages["1|null"] = page([ask("hello"), reply("old")], null, false);
  serve();
  await refresh();
  await refresh(true);
  setPendingTurn("hello", chatSnapshot().agentTraceItems);
  pages["0|null"] = page([ask("cur"), reply("c"), reply("fresh")], null, true);
  await refresh();
  expect(chatSnapshot().agentTraceItems.map((item) => item.text)).toEqual(["cur", "c", "fresh"]);
  expect(chatSnapshot().agentTracePending).toBe("hello");
  pages["0|null"] = page([ask("cur"), reply("c"), ask("hello")], null, true);
  await refresh();
  expect(chatSnapshot().agentTracePending).toBe("");
  expect(chatSnapshot().agentTraceOlder[0].items.map((item) => item.text)).toEqual(["hello", "old"]);
});

test("nothing of an older segment reaches the trace cache", async () => {
  pages["0|null"] = page([ask("cur"), reply("c")], null, true);
  pages["1|null"] = page([ask("older-secret"), reply("old")], null, false);
  serve();
  await refresh();
  await refresh(true);
  expect(chatSnapshot().agentTraceOlder).toHaveLength(1);
  expect(JSON.stringify(cachedAgentTrace("p1"))).not.toContain("older-secret");
});

test("a divider separates two segments in en and zh and is absent with only the current session", async () => {
  pages["0|null"] = page([ask("cur"), reply("c")], null, true);
  pages["1|null"] = page([ask("old"), reply("o")], null, false);
  serve();
  await refresh();
  expect(appRoot().querySelector("[role=separator]")).toBeNull();
  await refresh(true);
  const divider = appRoot().querySelectorAll("[role=separator]");
  expect(divider).toHaveLength(1);
  expect(divider[0].textContent).toBe("Earlier session");
  act(() => setLang("zh"));
  act(() => renderReact(<AgentChatPane includeBack handlers={handlers} />));
  expect(appRoot().querySelector("[role=separator]")?.textContent).toBe("更早的会话");
});
