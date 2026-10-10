import type { MediaSession } from './media-loader';

/** HTML dependencies must never fall back to relay, including later fetch() reads. */
export function previewMedia(session: MediaSession, root: string | undefined): MediaSession {
  return {
    workspaceMediaOpen: (pane, path) => session.workspaceMediaOpen(pane, path, root, { requireDirect: true }),
    workspaceMediaRead: (handle, offset, length) => session.workspaceMediaRead(handle, offset, length, { requireDirect: true }),
    workspaceMediaClose: handle => session.workspaceMediaClose(handle),
  };
}
