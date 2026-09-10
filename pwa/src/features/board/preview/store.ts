/**
 * Board pane preview store.
 *
 * The cache, its generation counter and the React subscription. It knows
 * nothing about the application record: a caller supplies the session to read
 * from, the pane ids, the line counts, and an `alive()` predicate that reports
 * when a newer pass, another session or another screen supersedes this one.
 */
import { previewFromRead, type Preview } from "./model";

export type PreviewRead = { text?: unknown; hash?: unknown };

export type PreviewSource = {
  paneRead(paneId: string, lines: number): Promise<PreviewRead | undefined>;
};

export type PreviewPass = {
  ids: string[];
  linesOf(paneId: string): number;
  source: PreviewSource;
  /** False once this pass must not publish: superseded, session swapped, or left. */
  alive(): boolean;
};

const previews = new Map<string, Preview>();
let generation = 0;
let tail: Promise<void> = Promise.resolve();
let previewRevision = 0;
const previewListeners = new Set<() => void>();

export function boardPreviewRevision(): number {
  return previewRevision;
}

export function previewGeneration(): number {
  return generation;
}

export function subscribeBoardPreviews(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

function notifyBoardPreviews(): void {
  previewRevision += 1;
  for (const listener of previewListeners) listener();
}

export function boardPreviewText(paneId: string): string {
  return previews.get(paneId)?.text || "";
}

export function boardPreviewSnapshot(paneId: string): Readonly<Preview> | undefined {
  return previews.get(paneId);
}

/** A new computer or a closed session starts from an empty cache. */
export function clearBoardPreviews(): void {
  generation += 1;
  previews.clear();
  notifyBoardPreviews();
}

/**
 * Publish one read unless an identical answer is already cached. The snapshot a
 * subscriber receives is frozen: a reader cannot edit the cache through it.
 */
export function publishPreview(paneId: string, read: PreviewRead | undefined): boolean {
  const next = Object.freeze(previewFromRead(read));
  const prev = previews.get(paneId);
  if (prev && next.hash && prev.hash === next.hash && prev.text === next.text) return false;
  previews.set(paneId, next);
  notifyBoardPreviews();
  return true;
}

/**
 * Drop panes that are gone. Publishing only when something was actually dropped
 * keeps a retired tile from showing a thumbnail of a pane that no longer exists,
 * without repainting on every pass.
 */
export function prunePreviews(livePaneIds: Iterable<string>): boolean {
  const live = livePaneIds instanceof Set ? livePaneIds : new Set(livePaneIds);
  let pruned = false;
  for (const paneId of [...previews.keys()]) {
    if (live.has(paneId)) continue;
    previews.delete(paneId);
    pruned = true;
  }
  if (pruned) notifyBoardPreviews();
  return pruned;
}

/** Supersede any in-flight pass. The token is what `alive()` compares against. */
export function nextPreviewGeneration(): number {
  generation += 1;
  return generation;
}

/** Serial pane reads. A later pass supersedes an in-flight one. */
export async function runPreviewPass(pass: PreviewPass): Promise<void> {
  for (const paneId of pass.ids) {
    if (!pass.alive()) return;
    try {
      const read = await pass.source.paneRead(paneId, pass.linesOf(paneId));
      // A late reply must not repopulate a cleared cache or notify another screen.
      if (!pass.alive()) return;
      publishPreview(paneId, read);
    } catch {
      /* a missed thumbnail is retried by the next pass */
    }
  }
}

/** Queue a pass behind the previous one so reads never interleave. */
export function enqueuePreviewPass(run: () => Promise<void>): Promise<void> {
  const next = tail.then(run, run);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
