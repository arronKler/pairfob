import { describe, expect, test } from "bun:test";
import { agentMeta, agentTitle, canPromptAgent, choosePane, chromeName, herdSignature, mapSnapshotAgents, paneFillCopy, statusLabel, tabIsSplit, visibleTabLabel } from "./dashboard.ts";

describe("dashboard mapping", () => {
  const snapshot = {
    focused: { pane_id: "w1:p1" },
    workspaces: [
      { workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" },
      { workspace_id: "w2", label: "Relay", cwd: "/repo/relay" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w2:t2", workspace_id: "w2", label: "relay" },
    ],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "working", label: "auth pane", history_available: true },
      { pane_id: "w2:p2", workspace_id: "w2", tab_id: "w2:t2", agent: "codex", agent_status: "blocked", cwd: "/tmp/custom" },
    ],
  };

  test("maps workspace labels and cwd fallbacks", () => {
    const agents = mapSnapshotAgents(snapshot);
    expect(agents[0].workspaceLabel).toBe("Pairfob");
    expect(agents[0].cwd).toBe("/repo/pairfob");
    expect(agents[0].tabId).toBe("w1:t1");
    expect(agents[0].tabLabel).toBe("main");
    expect(agents[0].paneLabel).toBe("auth pane");
    expect(agents[0].workspaceId).toBe("w1");
    expect(agents[0].historyAvailable).toBe(true);
    expect(agents[0].hasAgent).toBe(true);
    expect(agents[1].workspaceLabel).toBe("Relay");
    expect(agents[1].cwd).toBe("/tmp/custom");
    expect(agents[1].historyAvailable).toBe(false);
    expect(agents[1].hasAgent).toBe(true);
  });

  test("a tab with two panes is a split that can fill", () => {
    const agents = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [
        { pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "claude", scroll: { viewport_rows: 20 } },
        { pane_id: "p2", workspace_id: "w1", tab_id: "t1", agent: "codex", scroll: { viewport_rows: 18 } },
      ],
    });
    expect(tabIsSplit(agents[0], agents)).toBe(true);
    expect(paneFillCopy(agents[0], agents)?.menu).toBe("铺满全屏");
    agents[0].viewportRows = 48;
    expect(paneFillCopy(agents[0], agents)?.menu).toBe("退出全屏");
    expect(tabIsSplit(agents[0], [agents[0]])).toBe(false);
    expect(paneFillCopy(agents[0], [agents[0]])).toBeNull();
  });

  test("focused pane never overwrites a still-valid manual selection", () => {
    const agents = mapSnapshotAgents(snapshot);
    expect(choosePane("w2:p2", agents, snapshot.focused.pane_id)).toBe("w2:p2");
    expect(choosePane("gone", agents, snapshot.focused.pane_id)).toBe("w1:p1");
    expect(choosePane("gone", agents, "missing")).toBe("");
  });

  test("card copy uses a task title and short coordinates, not pane ids", () => {
    const agents = mapSnapshotAgents(snapshot);
    expect(agentTitle(agents[0])).toBe("auth pane");
    expect(agentMeta(agents[0])).toBe("claude · pairfob");
    expect(agentTitle(agents[1])).toBe("Relay");
    expect(agentMeta(agents[1])).toBe("codex · custom");
    expect(statusLabel("blocked")).toBe("等你");
  });

  test("space grouping puts the agent on the card instead of repeating the workspace", () => {
    const agents = mapSnapshotAgents(snapshot);
    expect(agentTitle(agents[0], "space")).toBe("auth pane");
    expect(agentMeta(agents[0], "space")).toBe("claude");
    expect(agentTitle(agents[1], "space")).toBe("codex");
    expect(agentMeta(agents[1], "space")).toBe("custom");
    const unnamed = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }],
    })[0];
    expect(agentTitle(unnamed)).toBe("codex");
    expect(agentMeta(unnamed)).toBe("pairfob");
    expect(agentMeta(unnamed, "space")).toBe("pairfob");
  });

  test("agent grouping keeps the agent in the title and the folder in the subtitle", () => {
    const unnamed = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle" }],
    })[0];
    expect(agentTitle(unnamed, "agent")).toBe("codex");
    expect(agentMeta(unnamed, "agent")).toBe("pairfob");
  });

  test("renders a renamed tab in session metadata", () => {
    const [agent] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "fix-tab" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "codex", agent_status: "idle" }],
    });
    expect(agentTitle(agent)).toBe("codex");
    expect(agentMeta(agent)).toBe("pairfob · fix-tab");
    expect(visibleTabLabel("main")).toBe("");
    expect(visibleTabLabel("fix-tab")).toBe("fix-tab");
  });

  test("task-like terminal titles fill in for unnamed panes", () => {
    const [agent] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "working", terminal_title: "Fix auth timeout" }],
    });
    expect(agent.terminalTitle).toBe("Fix auth timeout");
    expect(agentTitle(agent)).toBe("Fix auth timeout");
    expect(agentMeta(agent)).toBe("claude · pairfob");
  });

  test("machine terminal titles never become the card title", () => {
    const [pathTitle] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "idle", terminal_title: "user@host: ~/pairfob" }],
    });
    const [processTitle] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "idle", terminal_title: "zsh" }],
    });
    expect(agentTitle(pathTitle)).toBe("claude");
    expect(agentMeta(pathTitle)).toBe("pairfob");
    expect(agentTitle(processTitle)).toBe("claude");
    expect(agentMeta(processTitle)).toBe("pairfob");
  });

  test("a user pane name wins over workspace and terminal titles", () => {
    const [agent] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "修复登录问题", cwd: "/repo/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "idle", label: "auth pane", terminal_title: "Fix auth timeout" }],
    });
    expect(agentTitle(agent)).toBe("auth pane");
    expect(agentMeta(agent)).toBe("claude · pairfob");
  });

  test("a named workspace wins over a terminal title when the pane has no name", () => {
    const [agent] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "修复登录问题", cwd: "/repo/pairfob" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "idle", terminal_title: "Fix auth timeout" }],
    });
    expect(agentTitle(agent)).toBe("修复登录问题");
    expect(agentMeta(agent)).toBe("claude · pairfob");
  });

  test("herd signature changes for every snapshot field that changes visible UI", () => {
    const base = mapSnapshotAgents(snapshot);
    const signature = herdSignature(base);
    const mutations: Array<[string, (agent: (typeof base)[number]) => void]> = [
      ["pane label", (agent) => { agent.paneLabel = "renamed pane"; }],
      ["terminal title", (agent) => { agent.terminalTitle = "Fix auth timeout"; }],
      ["tab label", (agent) => { agent.tabLabel = "renamed tab"; }],
      ["workspace label", (agent) => { agent.workspaceLabel = "Renamed workspace"; }],
      ["cwd", (agent) => { agent.cwd = "/repo/other"; }],
      ["agent", (agent) => { agent.agent = "grok"; }],
      ["agent binding", (agent) => { agent.hasAgent = false; }],
      ["history", (agent) => { agent.historyAvailable = false; }],
      ["viewport", (agent) => { agent.viewportRows = 80; }],
    ];

    for (const [name, mutate] of mutations) {
      const agents = base.map((agent) => ({ ...agent }));
      mutate(agents[0]);
      expect(herdSignature(agents), name).not.toBe(signature);
    }
  });

  test("agentless panes stay visible without pretending to be shell agents", () => {
    const [pane] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "Pairfob", cwd: "/repo/pairfob" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "new tab" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent_status: "idle" }],
    });

    expect(pane.agent).toBe("");
    expect(pane.hasAgent).toBe(false);
    expect(agentTitle(pane)).toBe("终端");
    expect(agentMeta(pane)).toBe("pairfob");
    expect(canPromptAgent(pane)).toBe(false);
    expect(canPromptAgent(undefined)).toBe(false);
  });

  test("terminal panes without agent status still appear as idle shells", () => {
    const [pane] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "shell" }],
      panes: [{ pane_id: "p1", workspace_id: "w1" }],
    });
    expect(pane.hasAgent).toBe(false);
    expect(pane.status).toBe("idle");
    expect(agentTitle(pane)).toBe("shell");
    expect(agentMeta(pane)).toBe("终端");
  });

  test("missing labels never expose internal ids as names", () => {
    const [pane] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "ws_internal_123" }],
      tabs: [{ tab_id: "tab_internal_456", workspace_id: "ws_internal_123" }],
      panes: [{ pane_id: "pane_internal_789", workspace_id: "ws_internal_123", tab_id: "tab_internal_456" }],
    });
    expect(agentTitle(pane)).toBe("终端");
    expect(agentMeta(pane)).toBe("终端");
    expect(agentTitle(pane)).not.toContain("ws_internal_123");
    expect(agentMeta(pane)).not.toContain("tab_internal_456");
  });

  test("every card keeps a subtitle even after grouping", () => {
    const agents = mapSnapshotAgents(snapshot);
    for (const group of ["flat", "space", "agent"] as const) {
      for (const agent of agents) {
        expect(agentMeta(agent, group), `${agent.paneId} ${group}`).not.toBe("");
      }
    }
  });

  test("only panes with an explicit runtime agent binding can be prompted", () => {
    const agents = mapSnapshotAgents(snapshot);
    expect(canPromptAgent(agents[0])).toBe(true);
    expect(canPromptAgent(agents[1])).toBe(true);
  });

  test("OSC status crumbs and trailing agent names never become the card title", () => {
    const cases: Array<[string, string]> = [
      ["- Thinking - Pairfob session card title design - grok", "Pairfob session card title design"],
      ["- Waiting for response… - Session admin belongs on the list - grok", "Session admin belongs on the list"],
      ["Slim Pairfob docs, drop design internals - grok", "Slim Pairfob docs, drop design internals"],
      ["⠋ Thinking - Fix iOS keyboard overlay - grok", "Fix iOS keyboard overlay"],
    ];
    for (const [terminalTitle, want] of cases) {
      const [agent] = mapSnapshotAgents({
        workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/repo/pairfob" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", agent: "grok", agent_status: "working", terminal_title: terminalTitle }],
      });
      expect(agentTitle(agent), terminalTitle).toBe(want);
      expect(chromeName(agent), terminalTitle).toBe(want);
      expect(agentMeta(agent), terminalTitle).toBe("grok · pairfob");
      expect(agentTitle(agent), terminalTitle).not.toMatch(/Thinking|Waiting for response| - grok$/i);
    }
  });

  test("OSC crumbs in a pane label are cleaned the same way as a terminal title", () => {
    const [agent] = mapSnapshotAgents({
      workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/repo/pairfob" }],
      panes: [{
        pane_id: "p1",
        workspace_id: "w1",
        agent: "grok",
        agent_status: "working",
        label: "- Thinking - Fix mobile terminal chrome layout crowding - grok",
      }],
    });
    expect(agentTitle(agent)).toBe("Fix mobile terminal chrome layout crowding");
    expect(chromeName(agent)).toBe("Fix mobile terminal chrome layout crowding");
  });

  test("a short renamed pane still wins in the chrome", () => {
    const agents = mapSnapshotAgents(snapshot);
    expect(chromeName(agents[0])).toBe("auth pane");
  });
});
