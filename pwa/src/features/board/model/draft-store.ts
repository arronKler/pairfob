/**
 * Board layout draft.
 *
 * While a finger drags a divider the tiles re-layout live on the phone only;
 * nothing reaches the computer until release. The overlay writes the draft,
 * the canvas reads it and redraws the tiles with `layoutWithSplitRatio`. A
 * pending draft stays up while the resize request is in flight and is cleared
 * once the operation settled, so the next frame comes from the snapshot.
 */
export type LayoutDraft = { tabId: string; splitId: string; ratio: number; pending: boolean };

let current: LayoutDraft | null = null;
const listeners = new Set<() => void>();

export function setLayoutDraft(draft: LayoutDraft | null): void {
  if (draft === current) return;
  if (draft && current && draft.tabId === current.tabId && draft.splitId === current.splitId
    && draft.ratio === current.ratio && draft.pending === current.pending) return;
  current = draft ? { ...draft } : null;
  for (const listener of [...listeners]) listener();
}

/** Clear the draft only while it is still `draft`, so a settling request never wipes a newer drag. */
export function clearLayoutDraft(draft: LayoutDraft): void {
  if (current && current.tabId === draft.tabId && current.splitId === draft.splitId
    && current.ratio === draft.ratio && current.pending === draft.pending) setLayoutDraft(null);
}

export function layoutDraft(): LayoutDraft | null {
  return current;
}

export function subscribeLayoutDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
