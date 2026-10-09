import { describe, expect, test } from "bun:test";
import { agentDetailRows, agentMeta, agentTitle, chromeName, herdSignature, mapSnapshotAgents } from "./dashboard";

function card(title: string) {
  return mapSnapshotAgents({
    workspaces: [{ workspace_id: "w", label: "pairfob", cwd: "/repo/pairfob" }],
    panes: [{ pane_id: "p", workspace_id: "w", agent: "codex", agent_status: "working", terminal_title: title }],
  })[0];
}

describe("Codex terminal titles", () => {
  test("bound task metadata refreshes both titles without overriding manual names", () => {
    const startup = card("pairfob");
    const fallback = { ...startup, tokens: { task: "检查任务标题" } };
    const named = { ...fallback, tokens: { task: "修复 Codex 标题" } };
    expect(agentTitle(fallback)).toBe("检查任务标题");
    expect(chromeName(named)).toBe("修复 Codex 标题");
    expect(herdSignature([startup])).not.toBe(herdSignature([fallback]));
    expect(herdSignature([fallback])).not.toBe(herdSignature([named]));
    expect(agentTitle({ ...named, paneLabel: "我的任务" })).toBe("我的任务");
    expect(agentTitle({ ...named, workspaceLabel: "手动会话名" })).toBe("手动会话名");
    expect(agentTitle({ ...startup, paneId: "another" })).toBe("codex");
  });
  test("startup activity and project context do not masquerade as a task", () => {
    for (const title of ["| pairfob", "⠋ | pairfob", "⠋ pairfob", "| | pairfob", "/ | pairfob", "\\ | pairfob", "- | pairfob", "Ready | pairfob", "Starting | pairfob", "⠋", "|", "[ ! ] Action Required | pairfob"]) {
      const agent = card(title);
      expect(agentTitle(agent), title).toBe("codex");
      expect(chromeName(agent), title).toBe("codex");
      expect(agentMeta(agent), title).toBe("pairfob");
      expect(agentDetailRows(agent).some(row => row.value === title), title).toBe(false);
    }
  });

  test("task identity stays stable across animation and status changes", () => {
    for (const title of ["⠋ | 清理远端分支 | pairfob", "⠙ 清理远端分支 | pairfob", "| 清理远端分支 | pairfob", "/ 清理远端分支 | pairfob", "Ready | 清理远端分支 | pairfob", "[ . ] Action Required | 清理远端分支 | pairfob", "清理远端分支 ⠹ | pairfob", "清理远端分支 | pairfob"]) {
      const agent = card(title);
      for (const group of ["flat", "space", "agent"] as const) expect(agentTitle(agent, group), title).toBe("清理远端分支");
      expect(chromeName(agent), title).toBe("清理远端分支");
      expect(agentMeta(agent), title).toBe("codex · pairfob");
    }
  });

  test("manual names, other agents and meaningful title text retain their semantics", () => {
    const agent = card("⠋ | 清理远端分支 | pairfob");
    expect(agentTitle({ ...agent, paneLabel: "Review | pairfob" })).toBe("Review | pairfob");
    expect(agentTitle({ ...agent, workspaceLabel: "远端分支" })).toBe("远端分支");
    expect(agentTitle({ ...card("Review | pairfob"), agent: "claude" })).toBe("Review | pairfob");
    expect(agentTitle(card("Support A | B | pairfob"))).toBe("Support A | B");
    expect(agentTitle(card("Fix / paths | pairfob"))).toBe("Fix / paths");
    expect(agentTitle(card("Ready for release | pairfob"))).toBe("Ready for release");
  });
});
