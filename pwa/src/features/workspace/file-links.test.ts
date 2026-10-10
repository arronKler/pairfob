import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetTestDOM } from '../../../test-support/boot-dom';
import { WorkspaceSnapshotRestorer } from '../../../test-support/workspace-snapshot-restore';
import { setScreen } from '../../app/navigation-store';
import { clearNotice } from '../../app/notices-store';
import { attachLiveSession } from '../computers/catalog-store';
import { replaceAgentsFromSnapshot } from '../dashboard/catalog-store';
import { selectPane } from '../session/session-store';
import { setPhase } from '../connection/connection-store';
import { captureFileLinkOwner, openChatFile } from './file-links';
import { leaveWorkspace } from './actions';
import { getWorkspaceSnapshot } from './store';

await resetTestDOM();
const restorer = new WorkspaceSnapshotRestorer();
const revision = 'a'.repeat(64);
function seed(cwd = '/work/p1', runtime = 'main') {
  replaceAgentsFromSnapshot({ session: runtime, workspaces: [{ workspace_id: 'w1', label: 'repo', cwd }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'main' }],
    panes: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', cwd, agent: 'codex', agent_status: 'idle' }] });
}
function fixture(root = '/work/p1') {
  const reads: string[] = [];
  let runtime = 'main';
  const live = {
    isConnected: () => true, herdSession: () => runtime,
    workspaceOpen: async () => ({ name: 'repo', root, git: null, features: { files: true, git_status: false, git_diff: false, git_branches: false } }),
    workspaceList: async () => ({ path: '', entries: [], next_cursor: null, truncated: false, revision }),
    workspaceRead: async (_pane: string, path: string) => { reads.push(path); return { path, kind: 'text' as const, content: 'a\nb\nc', size: 5, modified_ms: 1, revision, truncated: false }; },
  };
  attachLiveSession(live as never);
  return { reads, switchRuntime() { runtime = 'other'; } };
}
beforeEach(() => { restorer.capture(); setPhase('live'); setScreen('pane'); selectPane('p1'); seed(); });
afterEach(() => { leaveWorkspace(); clearNotice(); attachLiveSession(null); restorer.restore(); });

test('a chat reference resolves against its owning pane root and carries its source line', async () => {
  const f = fixture();
  await openChatFile('/work/p1/app.ts:2', captureFileLinkOwner());
  expect(f.reads).toEqual(['app.ts']);
  expect(getWorkspaceSnapshot().sourceLine).toBe(2);
});

test('a sibling absolute path never becomes a workspace file read', async () => {
  const f = fixture();
  await openChatFile('/work/p10/app.ts', captureFileLinkOwner());
  expect(f.reads).toEqual([]);
  expect(getWorkspaceSnapshot().error).toBeTruthy();
});

test('retired session, cwd, pane and runtime references cannot read a new owner', async () => {
  for (const change of ['session', 'cwd', 'pane', 'runtime']) {
    setScreen('pane'); selectPane('p1'); seed();
    const f = fixture(), owner = captureFileLinkOwner();
    if (change === 'session') fixture();
    if (change === 'cwd') seed('/work/other');
    if (change === 'pane') selectPane('p2');
    if (change === 'runtime') f.switchRuntime();
    await openChatFile('app.ts', owner);
    expect(f.reads).toEqual([]);
  }
});


test('a root move reported before the next snapshot cannot reinterpret an old relative reference', async () => {
  const f = fixture('/work/moved');
  await openChatFile('app.ts', captureFileLinkOwner());
  expect(f.reads).toEqual([]);
  expect(getWorkspaceSnapshot().error).toBeTruthy();
});
