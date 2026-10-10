import { parkComposeView } from "../session/drafts/compose-drafts";
import { leaveAgentChat } from "../session/chat/agent-chat-controller";
import { showError } from "../../app/notices-store";
import { liveSession } from '../computers/catalog-store';
import { dashboardStore } from '../dashboard/catalog-store';
import { openPaneId } from '../session/session-store';
import { currentScreen } from '../../app/navigation-store';
import { isRoomy } from '../../app/viewport';
import { parseFileReference, workspaceReferencePath } from '../../lib/file-reference';
import { t } from '../../lib/i18n';
import { enterWorkspace, loadWorkspaceFile } from './actions';
import { openWorkspaceInspector } from './inspector';
import { getWorkspaceSnapshot, issueTicket } from './store';

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
  if (isRoomy()) await openWorkspaceInspector();
  else {
    parkComposeView();
    leaveAgentChat({ rememberGuided: false, paint: false });
    await enterWorkspace(owner.paneId, 'agent');
  }
  if (generation !== latestOpen || !owner.current()) return;
  const snap = getWorkspaceSnapshot();
  if (snap.paneId !== owner.paneId || !snap.descriptor) return;
  // A relative reply belongs to the cwd captured with that reply. A daemon
  // can report a moved root before its next dashboard snapshot reaches us.
  const anchored = !reference.path.startsWith('/') && owner.cwd?.startsWith('/')
    ? { ...reference, path: `${owner.cwd.replace(/\/+$/, '')}/${reference.path}` } : reference;
  const path = workspaceReferencePath(anchored, snap.descriptor.root);
  if (!path) { issueTicket()?.commit({ error: t('preview.outside') }); return; }
  await loadWorkspaceFile(path, reference.line ?? null);
}
