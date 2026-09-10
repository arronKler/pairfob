import { afterEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { setPhase } from "../connection/connection-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { isAgentChat, isFullTerminal, openPaneId, selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { composeDraft, setComposeDraft } from "../session/compose-store";
import { attachLiveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { batch } from "../../shared/model/domain-store";
import { captureComposeDraft, applyComposeDraft } from "../session/drafts/compose-drafts";
import type { WorkspaceAppNavigation } from "./navigation";
import type { WorkspaceReturnView } from "./model";
import { enterWorkspace, leaveWorkspace, setWorkspaceNavigationSeam } from "./index";
import { resetWorkspaceNavigationSeam } from "./navigation";

const seedRestorer = new WorkspaceSnapshotRestorer();
await resetTestDOM();

const revision = "a".repeat(64);

type PaintRecord = {
  screen: string;
  draft: string;
  fullTerminal: boolean;
  agentChat: boolean;
};

/** The same identity write the production default seam uses, at the fixture. */
function writeIdentity(next: WorkspaceAppNavigation): void {
  batch(() => {
    if (next.paneId !== undefined) selectPane(next.paneId);
    setScreen(next.screen);
    if (next.fullTerminal !== undefined) setFullTerminal(next.fullTerminal);
    if (next.agentChat !== undefined) setAgentChat(next.agentChat);
  });
}

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async () => ({
      name: "p1", root: "/work/p1",
      features: { files: true, git_status: false, git_diff: false, git_branches: false },
      git: null,
    }),
    workspaceList: async () => ({
      path: "", entries: [], next_cursor: null, truncated: false, revision,
    }),
  };
}

function prepare(mode: WorkspaceReturnView) {
  seedRestorer.capture();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(mode === "full");
  setAgentChat(mode === "agent");
  setComposeDraft(`preserved ${mode}`);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/p1", agent: "codex", agent_status: "idle" }],
  });
  attachLiveSession(liveFixture() as never);
}

afterEach(() => {
  leaveWorkspace();
  resetWorkspaceNavigationSeam();
  attachLiveSession(null);
  setScreen("home");
  selectPane("");
  seedRestorer.restore();
  setFullTerminal(false);
  setAgentChat(false);
  setComposeDraft("");
});

describe("workspace leave restores compose drafts", () => {
  for (const mode of ["guided", "full", "agent"] as const) {
    test(`${mode} round-trip keeps a nonempty unsent draft`, async () => {
      prepare(mode);
      const paints: PaintRecord[] = [];
      setWorkspaceNavigationSeam({
        applyIdentity: writeIdentity,
        paint() {
          paints.push({
            screen: currentScreen(),
            draft: composeDraft(),
            fullTerminal: isFullTerminal(),
            agentChat: isAgentChat(),
          });
        },
        notifyApp() {},
      });
      await enterWorkspace("p1", mode);
      expect(currentScreen()).toBe("workspace");
      leaveWorkspace();
      const painted = paints.at(-1);
      expect(painted?.screen).toBe("pane");
      expect(painted?.fullTerminal).toBe(mode === "full");
      expect(painted?.agentChat).toBe(mode === "agent");
      expect(painted?.draft).toBe(`preserved ${mode}`);
      expect(composeDraft()).toBe(`preserved ${mode}`);
      captureComposeDraft();
      setComposeDraft("");
      applyComposeDraft();
      expect(composeDraft()).toBe(`preserved ${mode}`);
    });
  }
});