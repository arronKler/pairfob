import { afterEach, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { attachLiveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { enterWorkspace, leaveWorkspace, showWorkspaceTab, loadDirectory } from "./actions";
import { getWorkspaceSnapshot } from "./store";
import type { LiveSession } from "../../lib/protocol/session-types";

await resetTestDOM();
afterEach(() => { leaveWorkspace(); attachLiveSession(null); });
function fixture(git = true) {
  const calls: string[] = [];
  const revision = "a".repeat(64);
  const session = {
    isConnected: () => true,
    workspaceOpen: async () => ({name:"repo",root:"/repo",features:{files:true,git_status:git,git_diff:false,git_branches:false},git:null}),
    workspaceList: async (_pane: string, path: string, cursor: string) => {
      calls.push(`list:${cursor}`);
      return {path, entries:[{name:cursor ? "b.txt":"a.txt",path:cursor ? "b.txt":"a.txt",kind:"file",size:1,modified_ms:1,hidden:false,revision}],next_cursor:cursor ? null:"next",truncated:false,revision};
    },
    gitStatus: async () => { calls.push("status"); return {branch:"main",head:"h",upstream:null,ahead:2,behind:0,truncated:false,revision,changes:[]}; },
  } as unknown as LiveSession;
  attachLiveSession(session);
  replaceAgentsFromSnapshot({workspaces:[{workspace_id:"w1",label:"repo"}],panes:[{pane_id:"p1",workspace_id:"w1",cwd:"/repo",agent:"codex",agent_status:"idle"}]});
  return calls;
}
async function settled() { for (let i=0;i<15;i++) await Promise.resolve(); }

test("changes entry skips the unused directory but retains shared Git metadata", async () => {
  const calls=fixture(); await enterWorkspace("p1");
  expect(calls).toEqual(["status"]);
  expect(getWorkspaceSnapshot().status?.ahead).toBe(2);
  showWorkspaceTab("files"); await settled();
  expect(calls).toEqual(["status","list:"]);
  expect(getWorkspaceSnapshot().entries[0]?.name).toBe("a.txt");
  showWorkspaceTab("changes"); showWorkspaceTab("files"); await settled();
  expect(calls).toEqual(["status","list:"]); // Existing root cache is reused.
});

test("old non-Git workspaces still load files on their first entry", async () => {
  const calls=fixture(false); await enterWorkspace("p1");
  expect(calls).toEqual(["list:"]);
  expect(getWorkspaceSnapshot().entries).toHaveLength(1);
});

test("a paginated directory survives leaving and returning through changes", async () => {
  fixture(); await enterWorkspace("p1","guided",false,"files");
  await loadDirectory("",true);
  expect(getWorkspaceSnapshot().entries).toHaveLength(2);
  showWorkspaceTab("changes"); leaveWorkspace();
  await enterWorkspace("p1");
  showWorkspaceTab("files"); await settled();
  expect(getWorkspaceSnapshot().entries.map(e=>e.name)).toEqual(["a.txt","b.txt"]);
});
