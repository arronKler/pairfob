import { parkComposeView } from "../session/drafts/compose-drafts";
import { leaveAgentChat } from "../session/chat/agent-chat-controller";
import { showError } from "../../app/notices-store";
import { liveSession } from '../computers/catalog-store';
import { dashboardStore } from '../dashboard/catalog-store';
import { openPaneId } from '../session/session-store';
import { currentScreen } from '../../app/navigation-store';
import { isRoomy } from '../../app/viewport';
import { parseFileReference } from '../../lib/file-reference';
import { t } from '../../lib/i18n';
import { ProtocolError } from '../../lib/protocol/errors';
import { messageOf } from '../../lib/notices';
import { enterWorkspace, loadDirectory, showWorkspaceTab, loadWorkspaceFile } from './actions';
import { openWorkspaceInspector } from './inspector';
import { activeScope, getWorkspaceSnapshot, readCache } from './store';

export function captureFileLinkOwner() {
  const session = liveSession();
  const paneId = openPaneId();
  const pane = dashboardStore.get().agents.find(item => item.paneId === paneId);
  const cwd = pane?.cwd;
  const runtime = pane?.runtimeSession;
  const herdSession = session?.herdSession?.();
  return {
    session, paneId, cwd,
    current() {
      const now = dashboardStore.get().agents.find(item => item.paneId === paneId);
      return !!session && liveSession() === session && openPaneId() === paneId && !!now
        && now.cwd === cwd && now.runtimeSession === runtime && session.herdSession?.() === herdSession;
    },
  };
}

let latestOpen = 0;
export async function openChatFile(value: string, owner: ReturnType<typeof captureFileLinkOwner>): Promise<void> {
  const reference = parseFileReference(value);
  if (!reference || currentScreen() !== 'pane') return;
  if (!owner.current()) { showError(t('preview.stale')); return; }
  const generation = ++latestOpen;
  const current = () => generation === latestOpen && owner.current();
  try {
    if (!owner.session?.workspaceResolve) throw new ProtocolError('unknown_op');
    // Resolve before entering the viewer: even its initial directory listing
    // must use a bound root, and failed links must leave the conversation open.
    const scope = await readCache(owner.session).open(owner.paneId);
    if (!current() || currentScreen() !== 'pane') return;
    const root = scope.descriptor.root;
    const path = !reference.path.startsWith('/') && !reference.path.startsWith('~/') && owner.cwd?.startsWith('/')
      ? `${owner.cwd.replace(/\/+$/, '')}/${reference.path}` : reference.path;
    const resolved = await owner.session.workspaceResolve(owner.paneId, root, path);
    if (!current() || currentScreen() !== 'pane') return;
    if (resolved.root !== root) throw new ProtocolError('forbidden');
    scope.requireRootBinding();
    if (isRoomy()) await openWorkspaceInspector();
    else {
      parkComposeView();
      leaveAgentChat({ rememberGuided: false, paint: false });
      await enterWorkspace(owner.paneId, 'agent');
    }
    if (!current()) return;
    const snap = getWorkspaceSnapshot();
    if (snap.paneId !== owner.paneId || snap.descriptor?.root !== root || activeScope()?.boundRoot !== root) return;
    if (resolved.kind === 'directory') {
      showWorkspaceTab('files');
      await loadDirectory(resolved.path);
    } else await loadWorkspaceFile(resolved.path, reference.line ?? null);
  } catch (error) {
    if (current()) showError(error instanceof ProtocolError && error.code === 'unknown_op' ? t('preview.homeUnsupported')
      : error instanceof ProtocolError && error.code === 'forbidden' ? t('preview.outside') : messageOf(error));
  }
}
