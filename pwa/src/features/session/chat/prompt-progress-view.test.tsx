import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import { applySnapshot, selectedAgent } from "../../dashboard/catalog-store";
import { selectPane } from "../session-store";
import { applyTrace, chatSnapshot, resetTrace } from "./trace-store";
import { createPromptProgress } from "./prompt-progress";
import { PromptProgressView, usePromptProgressNote } from "./prompt-progress-view";
const restorer = new WorkspaceSnapshotRestorer();
const snapshot = (status: string, seq = 1, occupant = "a") => ({ panes: [{ pane_id: "progress-pane", workspace_id: "w", agent: "codex", agent_status: status, agent_instance_id: occupant, state_change_seq: seq }] });
beforeEach(async () => {
  await resetBoardTestDOM(); unmountReact(); restorer.capture();
  act(() => { setLang("zh"); selectPane("progress-pane"); applySnapshot(snapshot("idle")); resetTrace(); });
});
afterEach(() => { unmountReact(); act(() => { resetTrace(); restorer.restore(); selectPane(""); }); });
function NoteProbe() {
  const note = usePromptProgressNote();
  return <p data-note={note ? `${note.attention ? "attention" : note.settled ? "settled" : "live"}` : "none"}>{note?.message ?? ""}</p>;
}
const probe = () => appRoot().querySelector<HTMLElement>("[data-note]")!;

test("the note follows accepted input and observed processing without claiming completion", () => {
  const progress = createPromptProgress(selectedAgent()!);
  act(() => applyTrace({ promptProgress: progress, agentTracePending: "check it" }));
  renderReact(<NoteProbe />);
  expect([probe().dataset.note, probe().textContent]).toEqual(["live", "正在发送…"]);
  act(() => applyTrace({ promptProgress: { ...progress, phase: "submitted" } }));
  expect(probe().textContent).toContain("等待观察到处理开始");
  act(() => applySnapshot(snapshot("working", 2)));
  expect(probe().textContent).toContain("已观察到 Agent 开始处理");
  expect(probe().dataset.note).toBe("settled");
  expect(chatSnapshot().promptProgress?.phase).toBe("processing");
  expect(probe().textContent).not.toContain("已完成");
  act(() => applySnapshot(snapshot("idle", 0, "replacement")));
  expect(probe().dataset.note).toBe("none");
});

test("an unobserved start becomes an attention note and never offers a resend", () => {
  act(() => applyTrace({ promptProgress: { ...createPromptProgress(selectedAgent()!, Date.now() - 9000), phase: "submitted" }, agentTracePending: "check it" }));
  renderReact(<NoteProbe />);
  expect(probe().dataset.note).toBe("attention");
  expect(probe().textContent).toContain("尚未观察到处理开始");
  expect(appRoot().querySelector("button")).toBeNull();
});

test("a leading slash for a non-Claude agent settles as sent to the terminal", () => {
  act(() => applyTrace({ promptProgress: { ...createPromptProgress(selectedAgent()!), phase: "submitted" }, agentTracePending: "/model" }));
  renderReact(<NoteProbe />);
  expect([probe().dataset.note, probe().textContent]).toEqual(["settled", "已发到终端 · 本地命令不会写进对话记录"]);
});

test("above the composer only an attention outcome without a pending turn remains", () => {
  const progress = createPromptProgress(selectedAgent()!);
  act(() => applyTrace({ promptProgress: { ...progress, phase: "unknown" }, agentTracePending: "" }));
  renderReact(<PromptProgressView />);
  expect(appRoot().querySelector("[data-prompt-progress]")?.className).toBe("agent-progress is-attention");
  act(() => applyTrace({ agentTracePending: "still pending" }));
  expect(appRoot().querySelector("[data-prompt-progress]")).toBeNull();
  act(() => applyTrace({ promptProgress: { ...progress, phase: "recorded" }, agentTracePending: "" }));
  expect(appRoot().querySelector("[data-prompt-progress]")).toBeNull();
});
