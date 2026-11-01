import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import type { LiveSession, PairResult } from "../../lib/protocol/client";
import type { AgentTracePage } from "../../lib/operations";
import { attachLiveSession, setCredential } from "../computers/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { resetObservationLifecycle, selectPane, setAgentChat } from "../session/session-store";
import { ComputerSessions } from "../computers/session-pool";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { bindSessionOwnerFromLive } from "../session/bind-live";
import { leaveAgentChat, refreshAgentTrace } from "../session/chat/agent-chat-controller";
import { observeSessionEvent, type SessionEventPorts } from "./session-events";

const pair: PairResult = { daemonId: "A", deviceId: "dev", fp: "f" } as unknown as PairResult;
const page: AgentTracePage = { items: [{ type: "user", text: "hi" }], nextCursor: "" };

let reads: Array<() => void>;
let session: LiveSession;
let pool: ComputerSessions;

// wakePane is the real path of a poke on the open pane: the trace lane.
const ports = {
  documentVisible: () => true,
  handleGuidedEvent: () => false,
  handleFullTerminalEvent: () => false,
  wakePane: () => { void refreshAgentTrace(); },
  refreshSnapshot: async () => undefined,
} as unknown as SessionEventPorts;

const poke = (paneId: string) =>
  observeSessionEvent(pool, "A", session, { type: "poke", paneId, reason: "agent_trace" }, ports);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  await resetTestDOM();
  reads = [];
  resetObservationLifecycle();
  setScreen("pane");
  selectPane("p1");
  setAgentChat(true);
  session = {
    isConnected: () => true,
    onEvent: () => () => undefined,
    close() {},
    agentTrace: () => new Promise<AgentTracePage>((resolve) => { reads.push(() => resolve(page)); }),
  } as unknown as LiveSession;
  pool = new ComputerSessions(3);
  await pool.activate(pair, async () => session);
  attachLiveSession(session);
  setCredential(pair);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp", agent: "pi", agent_status: "idle", history_available: true }],
  });
  bindSessionOwnerFromLive();
});

afterEach(() => {
  leaveAgentChat({ paint: false, rememberGuided: false });
  attachLiveSession(null);
  resetObservationLifecycle();
  selectPane("");
  setScreen("home");
});

describe("agent_trace poke", () => {
  test("a poke for the open pane causes one trace read", async () => {
    poke("p1");
    await tick();
    expect(reads.length).toBe(1);
    reads[0]!();
    await tick();
    expect(reads.length).toBe(1);
  });

  test("two pokes during a read cause one follow-up and no more", async () => {
    poke("p1");
    await tick();
    poke("p1");
    poke("p1");
    await tick();
    expect(reads.length).toBe(1);
    reads[0]!();
    await tick();
    expect(reads.length).toBe(2);
    reads[1]!();
    await tick();
    expect(reads.length).toBe(2);
  });

  test("a poke for another pane causes no read", async () => {
    poke("p2");
    await tick();
    expect(reads.length).toBe(0);
  });
});
