/**
 * The single DOM root lookup.
 *
 * Pure state modules never touch `#app`; only this adapter and the imperative
 * integrations that own DOM (terminal, scroll, focus) do. Resolution is lazy so
 * importing a model module has no DOM requirement — the browser boot lifecycle
 * (`app/bootstrap.ts`) and the React mount (`app/mount.tsx`) are the first
 * callers in production.
 */

let bound: HTMLElement | null = null;

/** Resolve `#app`, remembering it until it leaves the document. */
export function appRoot(): HTMLElement {
  if (bound?.isConnected) return bound;
  const element = document.getElementById("app");
  if (!element) throw new Error("missing #app");
  bound = element;
  return element;
}

/** The resolved root, or null before the first lookup. Never throws. */
export function tryAppRoot(): HTMLElement | null {
  return bound?.isConnected ? bound : document.getElementById("app");
}

/**
 * The currently bound root node, returned even when it has left the document or
 * was adopted into a different realm.
 *
 * Production code resolves through {@link appRoot}/{@link tryAppRoot}; this is a
 * test-lifecycle accessor. A realm or body reset can detach the bound `#app` or
 * leave it adopted by the previous realm while the mounted React root still lives
 * on it. The realm restore helper reads THIS node (never a freshly resolved
 * replacement) and reconnects it — `appendChild` auto-adopts it back from a
 * foreign ownerDocument — so the bound node is not released or replaced. Null
 * before the first binding or after {@link releaseAppRoot}.
 */
export function boundAppRoot(): HTMLElement | null {
  return bound;
}

/** Adopt an explicit root (fixtures, tests, a re-created document). */
export function bindAppRoot(element: HTMLElement): void {
  bound = element;
}

/** Forget the root so the next lookup re-resolves it. Teardown only. */
export function releaseAppRoot(): void {
  bound = null;
}
