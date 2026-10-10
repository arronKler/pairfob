import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetTestDOM } from '../../../test-support/boot-dom';
import { WorkspaceSnapshotRestorer } from '../../../test-support/workspace-snapshot-restore';
import { setScreen } from '../../app/navigation-store';
import { clearNotice, visibleNotice } from '../../app/notices-store';
import { attachLiveSession } from '../computers/catalog-store';
import { replaceAgentsFromSnapshot } from '../dashboard/catalog-store';
import { selectPane } from '../session/session-store';
import { setPhase } from '../connection/connection-store';
import { captureFileLinkOwner, openChatFile } from './file-links';
import { ProtocolError } from '../../lib/protocol/errors';
import type { WorkspaceReference } from '../../lib/protocol/workspace-reference';
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
  const lists: string[] = [];
  let runtime = 'main';
  const live = {
    isConnected: () => true, herdSession: () => runtime,
    workspaceOpen: async () => ({ name: 'repo', root, git: null, features: { files: true, git_status: false, git_diff: false, git_branches: false } }),
    workspaceList: async (_pane: string, path = '', _cursor?: string, _limit?: number, expected?: string) => { expect(expected).toBe(root); lists.push(path); return { path, entries: [], next_cursor: null, truncated: false, revision }; },
    workspaceResolve: (async (_pane: string, expectedRoot: string, input: string): Promise<WorkspaceReference> => {
      if (root !== expectedRoot || !input.startsWith(root + '/')) throw new ProtocolError('forbidden');
      return { root, path: input.slice(root.length + 1), kind: 'file' };
    }) as undefined | ((pane: string, root: string, path: string) => Promise<WorkspaceReference>),
    workspaceRead: async (_pane: string, path: string, expected?: string) => { expect(expected).toBe(root); reads.push(path); return { path, kind: 'text' as const, content: 'a\nb\nc', size: 5, modified_ms: 1, revision, truncated: false }; },
  };
  attachLiveSession(live as never);
  return { reads, lists, live, switchRuntime() { runtime = 'other'; } };
}
beforeEach(() => { restorer.capture(); setPhase('live'); setScreen('pane'); selectPane('p1'); seed(); });
afterEach(() => { leaveWorkspace(); clearNotice(); attachLiveSession(null); restorer.restore(); });

test('a chat reference resolves against its owning pane root and carries its source line', async () => {
  const f = fixture();
  await openChatFile('/work/p1/app.ts:2', captureFileLinkOwner());
  expect(f.reads).toEqual(['app.ts']);
  expect(getWorkspaceSnapshot().sourceLine).toBe(2);
});

test('a file URI uses the paired workspace and retains line navigation', async () => {
  const f = fixture();
  await openChatFile('file:///work/p1/report.html:2', captureFileLinkOwner());
  expect(f.reads).toEqual(['report.html']);
  expect(getWorkspaceSnapshot().sourceLine).toBe(2);
});

test('a file URI outside the current workspace remains outside its read scope', async () => {
  const f = fixture();
  await openChatFile('file:///tmp/report.html', captureFileLinkOwner());
  expect(f.reads).toEqual([]);
  expect(visibleNotice()?.text).toBeTruthy();
});

test('a sibling absolute path never becomes a workspace file read', async () => {
  const f = fixture();
  await openChatFile('/work/p10/app.ts', captureFileLinkOwner());
  expect(f.reads).toEqual([]);
  expect(visibleNotice()?.text).toBeTruthy();
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
  expect(visibleNotice()?.text).toBeTruthy();
});


test('daemon resolves home paths and directories, including directories with dots', async () => {
  for (const [value, path, kind] of [
    ['~/Project/report.html:2', 'report.html', 'file'],
    ['~/Project', '', 'directory'],
    ['/work/p1/dir.with.dot', 'dir.with.dot', 'directory'],
  ] as const) {
    setScreen('pane');
    const f = fixture();
    f.live.workspaceResolve = async (_pane, root, input) => {
      expect(root).toBe('/work/p1');
      expect(input).toBe(value.replace(':2', ''));
      return { root, path, kind };
    };
    await openChatFile(value, captureFileLinkOwner());
    expect(getWorkspaceSnapshot().error).toBe('');
    if (kind === 'file') { expect(f.reads).toEqual([path]); expect(getWorkspaceSnapshot().sourceLine).toBe(2); }
    else { expect(f.reads).toEqual([]); expect(f.lists.at(-1)).toBe(path); expect(getWorkspaceSnapshot().tab).toBe('files'); }
    leaveWorkspace();
  }
});

test('old daemons never reinterpret home as a relative folder', async () => {
  const f = fixture();
  f.live.workspaceResolve = async () => { throw new ProtocolError('unknown_op'); };
  await openChatFile('~/report.html', captureFileLinkOwner());
  expect(f.reads).toEqual([]);
  expect(visibleNotice()?.text).toBeTruthy();
});

test('resolver failures, stale owners and mismatched roots cannot trigger reads', async () => {
  for (const mode of ['failure', 'owner', 'root']) {
    setScreen('pane'); seed();
    const f = fixture();
    f.live.workspaceResolve = async () => {
      if (mode === 'failure') throw new ProtocolError('forbidden');
      if (mode === 'owner') seed('/work/other');
      return { root: mode === 'root' ? '/work/other' : '/work/p1', path: 'report.html', kind: 'file' };
    };
    await openChatFile('~/report.html', captureFileLinkOwner());
    expect(f.reads).toEqual([]);
    leaveWorkspace();
  }
});


test('unsupported resolver performs no unbound listing or file read', async () => {
  for (const reference of ['~/report.html', '/work/p1/report.html', 'report.html']) {
    setScreen('pane');
    const f = fixture();
    f.live.workspaceResolve = async () => { throw new ProtocolError('unknown_op'); };
    await openChatFile(reference, captureFileLinkOwner());
    expect(f.reads).toEqual([]);
    expect(f.lists).toEqual([]);
    expect(visibleNotice()?.text).toBeTruthy();
  }
});

test('leaving the conversation during resolution prevents late viewer navigation', async () => {
  const f = fixture();
  let finish!: (value: WorkspaceReference) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.live.workspaceResolve = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const opening = openChatFile('/work/p1/report.html', captureFileLinkOwner());
  await started;
  setScreen('home');
  finish({ root: '/work/p1', path: 'report.html', kind: 'file' });
  await opening;
  expect(f.reads).toEqual([]);
  expect(f.lists).toEqual([]);
});
