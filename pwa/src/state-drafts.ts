import { composeDraftKey, type ComposeDraftScope } from "./lib/compose-draft-scope";

/** Bounded in-memory compose drafts. Prompt text never goes to localStorage. */
const MAX_DRAFTS = 32;

export type StoredComposeDraft = {
  text: string;
  error: string;
  revision: number;
};

const emptyDraft = (): StoredComposeDraft => ({ text: "", error: "", revision: 0 });

const drafts = new Map<string, StoredComposeDraft>();
let viewIncarnation = 0;
let lockSerial = 0;
let heldLock = 0;
let busyOwner = 0;

function touch(key: string, entry: StoredComposeDraft): void {
  drafts.delete(key);
  drafts.set(key, entry);
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (typeof oldest !== "string") break;
    drafts.delete(oldest);
  }
}

export function currentViewIncarnation(): number {
  return viewIncarnation;
}

/** Pane, mode, and session identity for async UI. Does not drop an in-flight lock. */
export function bumpViewIncarnation(): number {
  viewIncarnation += 1;
  return viewIncarnation;
}

export function nextPromptLockId(): number {
  lockSerial += 1;
  return lockSerial;
}

export function holdPromptLock(id: number): void {
  heldLock = id;
  busyOwner = id;
}

export function unstickPromptBusy(): boolean {
  if (!heldLock || busyOwner !== heldLock) return false;
  busyOwner = 0;
  return true;
}

export function releasePromptLock(id: number): { owned: boolean; clearedBusy: boolean } {
  if (heldLock !== id) return { owned: false, clearedBusy: false };
  heldLock = 0;
  const clearedBusy = busyOwner === id;
  if (clearedBusy) busyOwner = 0;
  return { owned: true, clearedBusy };
}

export function promptLockHeld(id: number): boolean {
  return heldLock === id;
}

export function dropPromptLocks(): void {
  heldLock = 0;
  busyOwner = 0;
}

export function readStoredDraft(scope: ComposeDraftScope): StoredComposeDraft {
  const entry = drafts.get(composeDraftKey(scope));
  return entry ? { ...entry } : emptyDraft();
}

export function writeStoredDraft(scope: ComposeDraftScope, patch: Partial<StoredComposeDraft>): StoredComposeDraft {
  const key = composeDraftKey(scope);
  const next = { ...readStoredDraft(scope), ...patch };
  if (!next.text && !next.error && next.revision <= 0) {
    drafts.delete(key);
    return emptyDraft();
  }
  touch(key, next);
  return { ...next };
}

export function bumpDraftRevision(scope: ComposeDraftScope): number {
  const revision = readStoredDraft(scope).revision + 1;
  writeStoredDraft(scope, { revision });
  return revision;
}

export function clearDraftStore(): void {
  drafts.clear();
  heldLock = 0;
  busyOwner = 0;
}

export function draftStoreSize(): number {
  return drafts.size;
}
