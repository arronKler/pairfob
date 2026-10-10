import type { MediaSession } from './media-loader';

/** Every preview dependency uses the root captured by its workspace scope. */
export function rootBoundMedia(session: MediaSession, root: string | undefined): MediaSession {
  if (root === undefined) return session;
  return {
    workspaceMediaOpen: (pane, path) => session.workspaceMediaOpen(pane, path, root),
    workspaceMediaRead: (handle, offset, length) => session.workspaceMediaRead(handle, offset, length),
    workspaceMediaClose: handle => session.workspaceMediaClose(handle),
  };
}
