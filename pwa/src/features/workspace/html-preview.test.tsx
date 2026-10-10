import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useSyncExternalStore } from 'react';
import { happy, resetBoardTestDOM } from '../../../test-support/dom';
import { renderReact, unmountReact } from '../../../test-support/react-harness';
import { attachLiveSession } from '../computers/catalog-store';
import { connectionStore, setPhase, setSessionTransport, setNetworkOnline, setTransportSwitching } from '../connection/connection-store';
import { WorkspaceReadCache } from '../../lib/workspace-cache';
import type { LiveSession } from '../../lib/protocol/session-types';
import { HTMLPreview } from './html-preview';
import { usePreviewControls } from './preview-controls';
import { loadWorkspaceFile } from './actions';
import * as store from './store';

const revision = 'a'.repeat(64);
const emptySHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
let opens = 0;
let previousNetwork: ReturnType<typeof connectionStore.get>;

function View() {
  const snapshot = useSyncExternalStore(store.subscribeWorkspace, store.getWorkspaceSnapshot);
  const controls = usePreviewControls(snapshot);
  return <HTMLPreview snapshot={snapshot} wrap={false} controls={controls} />;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  previousNetwork = connectionStore.get();
  setPhase('live'); setNetworkOnline(true); setTransportSwitching(false); setSessionTransport('p2p');
  opens = 0;
  const api = {
    workspaceOpen: async () => ({ name: 'work', root: '/work', git: null,
      features: { files: true, git_status: false, git_diff: false, git_branches: false } }),
    workspaceRead: async (_pane: string, path: string) => ({ path, kind: 'text' as const, size: 0,
      modified_ms: 1, content: '', revision, truncated: false }),
    workspaceMediaOpen: async (_pane: string, path: string) => {
      opens++;
      return { handle: 'media_' + 'a'.repeat(32), path, kind: 'download' as const, mime: 'text/html', size: 0,
        modified_ms: 1, sha256: emptySHA, chunk_bytes: 65536, max_bytes: 33554432, max_pixels: 0,
        width: 0, height: 0, expires_ms: Date.now() + 60000 };
    },
    workspaceMediaRead: async () => { throw new Error('empty files need no chunks'); },
    workspaceMediaClose: async () => undefined,
  };
  const live = api as unknown as LiveSession;
  attachLiveSession(live);
  const { ticket } = store.beginEnter(live, 'pane', 'agent');
  const scope = await new WorkspaceReadCache(api as never, () => '/work').open('pane');
  store.bindScope(ticket, scope);
  ticket.commit({ descriptor: scope.descriptor, view: 'file', detailPath: 'report.html',
    file: await api.workspaceRead('pane', 'report.html') });
  ticket.finishLoad();
});

afterEach(async () => {
  unmountReact(); store.beginLeave(); attachLiveSession(null);
  setPhase(previousNetwork.phase); setSessionTransport(previousNetwork.sessionTransport);
  setNetworkOnline(previousNetwork.networkOnline); setTransportSwitching(previousNetwork.transportSwitching);
  await happy.happyDOM.abort();
});

async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }

test('reopening identical content replaces its preview ticket without a false stale error', async () => {
  renderReact(<View />); await settle();
  expect(opens).toBe(1);
  expect(document.querySelector('iframe')).not.toBeNull();
  await act(async () => { await loadWorkspaceFile('report.html'); });
  await settle();
  expect(opens).toBeGreaterThan(1);
  expect(document.querySelector('iframe')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('relay blocks HTML media, P2P recovery starts it, and fallback removes the frame', async () => {
  setSessionTransport('relay'); renderReact(<View />); await settle();
  expect(opens).toBe(0);
  expect(document.querySelector('iframe')).toBeNull();
  await act(async () => { setSessionTransport('p2p'); }); await settle();
  expect(opens).toBe(1);
  expect(document.querySelector('iframe')).not.toBeNull();
  await act(async () => { setSessionTransport('relay'); }); await settle();
  expect(document.querySelector('iframe')).toBeNull();
  expect(opens).toBe(1);
});
