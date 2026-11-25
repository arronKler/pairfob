import { useSyncExternalStore } from "react";
import { pointerFine } from "../../app/input-mode";

/**
 * Per-device reading preferences for the inspector. Storage can be missing or
 * throw (private mode, blocked site data); the default then simply applies.
 *
 * Wrapping defaults by how the page is operated, not by its width: under a
 * finger long lines wrap, because panning a file sideways to read every line
 * is the worst way to read one; a mouse keeps lines whole, as an editor does.
 * Once the reader has chosen, the choice is theirs on this device either way.
 */
const WRAP_KEY = "pairfob.workspace.wrap";
const listeners = new Set<() => void>();

function readWrap(): boolean | null {
  try {
    const stored = globalThis.localStorage?.getItem(WRAP_KEY);
    return stored === "1" ? true : stored === "0" ? false : null;
  } catch {
    return null;
  }
}

/** The reader's own choice; null until they make one. */
let chosen = readWrap();

export function workspaceWrap(): boolean {
  return chosen ?? !pointerFine();
}

export function setWorkspaceWrap(next: boolean): void {
  chosen = next;
  try { globalThis.localStorage?.setItem(WRAP_KEY, next ? "1" : "0"); } catch { /* keep the in-memory value */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useWorkspaceWrap(): boolean {
  return useSyncExternalStore(subscribe, workspaceWrap, workspaceWrap);
}

/** Tests: back to no choice, so the default for the input applies. */
export function resetWorkspaceWrap(): void {
  chosen = null;
  try { globalThis.localStorage?.removeItem(WRAP_KEY); } catch { /* ignore */ }
  for (const listener of listeners) listener();
}

/**
 * How a diff reads at arm's length: the size of its lines, and whether they
 * wrap. Until the reader picks a size the style sheet's own applies (it
 * follows the terminal's size, a size up under a finger), so a desktop diff
 * reads exactly as it did. A diff wraps until they turn it off, under a mouse
 * too, as it always has: unlike a file's, its lines are read beside their
 * neighbours, and a removal and its replacement are compared whole. The two
 * wraps are kept apart so that turning one off never turns off the other.
 */
/** As large as a reader with poor sight needs: two fingers on the lines take these steps, not the page's zoom. */
export const DIFF_SIZES = [12, 13.5, 15, 17, 19] as const;
const DIFF_SIZE_KEY = "pairfob.workspace.diffSize";
const DIFF_WRAP_KEY = "pairfob.workspace.diffWrap";
const diffListeners = new Set<() => void>();
const beforeDiffListeners = new Set<() => void>();

function readDiffSize(): number | null {
  try {
    const stored = Number(globalThis.localStorage?.getItem(DIFF_SIZE_KEY));
    return DIFF_SIZES.find((size) => size === stored) ?? null;
  } catch {
    return null;
  }
}

function readDiffWrap(): boolean {
  try {
    return globalThis.localStorage?.getItem(DIFF_WRAP_KEY) !== "0";
  } catch {
    return true;
  }
}

let diffSizeChosen = readDiffSize();
let diffWraps = readDiffWrap();

function diffChanged(): void {
  for (const listener of diffListeners) listener();
}

/**
 * Hear just before the size or the wrap changes, while the lines are still
 * drawn the old way: an open diff keeps the line being read where it is, from
 * whichever control, key or pinch the change came.
 */
export function beforeReadingChange(listener: () => void): () => void {
  beforeDiffListeners.add(listener);
  return () => { beforeDiffListeners.delete(listener); };
}

function aboutToChange(): void {
  for (const listener of beforeDiffListeners) listener();
}

function subscribeDiff(listener: () => void): () => void {
  diffListeners.add(listener);
  return () => { diffListeners.delete(listener); };
}

/** The reader's size in px; null while the style sheet's applies. */
export function diffSize(): number | null {
  return diffSizeChosen;
}

export function setDiffSize(next: number | null): void {
  const size = next === null ? null : DIFF_SIZES.find((step) => step === next) ?? null;
  if (size === diffSizeChosen) return;
  aboutToChange();
  diffSizeChosen = size;
  try {
    if (size === null) globalThis.localStorage?.removeItem(DIFF_SIZE_KEY);
    else globalThis.localStorage?.setItem(DIFF_SIZE_KEY, String(size));
  } catch { /* keep the in-memory value */ }
  diffChanged();
}

export function useDiffSize(): number | null {
  return useSyncExternalStore(subscribeDiff, diffSize, diffSize);
}

/** Tests: back to the style sheet's size. */
export function resetDiffSize(): void {
  setDiffSize(null);
}

export function diffWrap(): boolean {
  return diffWraps;
}

export function setDiffWrap(next: boolean): void {
  if (next === diffWraps) return;
  aboutToChange();
  diffWraps = next;
  try { globalThis.localStorage?.setItem(DIFF_WRAP_KEY, next ? "1" : "0"); } catch { /* keep the in-memory value */ }
  diffChanged();
}

export function useDiffWrap(): boolean {
  return useSyncExternalStore(subscribeDiff, diffWrap, diffWrap);
}

/** Tests: back to wrapping, with nothing kept. */
export function resetDiffWrap(): void {
  diffWraps = true;
  try { globalThis.localStorage?.removeItem(DIFF_WRAP_KEY); } catch { /* ignore */ }
  diffChanged();
}

/**
 * The width an HTML preview is drawn at: a phone's, a tablet's, a PC's, or the
 * room the page has. A page drawn wider than the stage is read through the
 * preview's zoom surface, so the width can be chosen on any screen; whether a
 * choice is offered, and so whether it applies, is the preview's own question
 * (`preview-controls`).
 */
/** The width a page is drawn at when it is read as a PC draws it. */
export const PREVIEW_DESKTOP_WIDTH = 1280;
export const PREVIEW_WIDTHS = [375, 768, PREVIEW_DESKTOP_WIDTH] as const;
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number] | "auto";

const PREVIEW_WIDTH_KEY = "pairfob.workspace.previewWidth";
const previewWidthListeners = new Set<() => void>();

function readPreviewWidth(): PreviewWidth {
  try {
    const stored = Number(globalThis.localStorage?.getItem(PREVIEW_WIDTH_KEY));
    return PREVIEW_WIDTHS.find((width) => width === stored) ?? "auto";
  } catch {
    return "auto";
  }
}

let previewWidthChosen = readPreviewWidth();

export function previewWidth(): PreviewWidth {
  return previewWidthChosen;
}

export function setPreviewWidth(next: PreviewWidth): void {
  previewWidthChosen = next;
  try {
    if (next === "auto") globalThis.localStorage?.removeItem(PREVIEW_WIDTH_KEY);
    else globalThis.localStorage?.setItem(PREVIEW_WIDTH_KEY, String(next));
  } catch { /* keep the in-memory value */ }
  for (const listener of previewWidthListeners) listener();
}

function subscribePreviewWidth(listener: () => void): () => void {
  previewWidthListeners.add(listener);
  return () => { previewWidthListeners.delete(listener); };
}

export function usePreviewWidth(): PreviewWidth {
  return useSyncExternalStore(subscribePreviewWidth, previewWidth, previewWidth);
}

/** Tests: back to the room the page has. */
export function resetPreviewWidth(): void {
  setPreviewWidth("auto");
}

/**
 * How wide the list is beside the open file, where the screen shows both. The
 * reader sets it by dragging the line between them (`list-divider`); until
 * they do, the layout's own width applies. The style sheet holds whatever is
 * kept here to the room the window has.
 */
const LIST_WIDTH_KEY = "pairfob.workspace.listWidth";
const listWidthListeners = new Set<() => void>();

function readListWidth(): number | null {
  try {
    const stored = Number(globalThis.localStorage?.getItem(LIST_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : null;
  } catch {
    return null;
  }
}

/** In px; null until the reader sets one. */
let listWidthChosen = readListWidth();

export function workspaceListWidth(): number | null {
  return listWidthChosen;
}

export function setWorkspaceListWidth(next: number | null): void {
  listWidthChosen = next === null ? null : Math.round(next);
  try {
    if (listWidthChosen === null) globalThis.localStorage?.removeItem(LIST_WIDTH_KEY);
    else globalThis.localStorage?.setItem(LIST_WIDTH_KEY, String(listWidthChosen));
  } catch { /* keep the in-memory value */ }
  for (const listener of listWidthListeners) listener();
}

function subscribeListWidth(listener: () => void): () => void {
  listWidthListeners.add(listener);
  return () => { listWidthListeners.delete(listener); };
}

export function useWorkspaceListWidth(): number | null {
  return useSyncExternalStore(subscribeListWidth, workspaceListWidth, workspaceListWidth);
}

/** Tests: back to the layout's own width. */
export function resetWorkspaceListWidth(): void {
  setWorkspaceListWidth(null);
}
