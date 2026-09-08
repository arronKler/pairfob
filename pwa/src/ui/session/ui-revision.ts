/** Snapshot/chrome paints that do not pass through the application router. */
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
