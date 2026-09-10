/**
 * Session leaf revision, NOT a publication boundary.
 *
 * A snapshot/chrome paint that does not pass through the application router
 * bumps this revision so SessionPane re-reads the already-published owned
 * stores. It never publishes domains, never enters a publication transaction,
 * and never flushes the global dirty set: the ordinary same-owner writes
 * (applyPaneRead / batch(setPaneFollow, setPaneUnread)) have already published
 * their own snapshot by the time this runs, and a held staged composition is
 * left to the already-queued App commit.
 *
 * Guarded by compositionPublicationHeld() in the patch callers, not here.
 */
let revision = 0;
const listeners = new Set<() => void>();

export function sessionUIRevision(): number {
  return revision;
}

export function subscribeSessionUI(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifySessionUI(): void {
  revision++;
  for (const listener of listeners) listener();
}
