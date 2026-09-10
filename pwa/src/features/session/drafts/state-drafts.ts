import { composeDraftKey, type ComposeDraftScope } from "../../../lib/compose-draft-scope";

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
/** Global attempt token. Must not rewind on LRU eviction or store clear. */
let revisionSerial = 0;
let heldLock = 0;
let busyOwner = 0;

/**
 * Drafts parked by a retired live field (guided compose IME transfer). While a
 * scope is parked, an ordinary capture with an empty visible draft must not
 * overwrite the parked text: the empty field belongs to the replacement
 * incarnation that never held it. Applying the draft makes it visible again
 * and retires the mark, so a later deliberate clear still sticks.
 *
 * A mark retires with its stored entry: LRU eviction, empty-entry deletion
 * and a full store clear all drop it, so the set stays bounded by MAX_DRAFTS
 * and a recreated scope never inherits stale protection.
 */
const parkedScopes = new Set<string>();

export function parkStoredDraft(scope: ComposeDraftScope): void {
  parkedScopes.add(composeDraftKey(scope));
}

export function storedDraftIsParked(scope: ComposeDraftScope): boolean {
  return parkedScopes.has(composeDraftKey(scope));
}

export function clearParkedDraft(scope: ComposeDraftScope): void {
  parkedScopes.delete(composeDraftKey(scope));
}

function touch(key: string, entry: StoredComposeDraft): void {
  drafts.delete(key);
  drafts.set(key, entry);
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (typeof oldest !== "string") break;
    drafts.delete(oldest);
    parkedScopes.delete(oldest);
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
    parkedScopes.delete(key);
    return emptyDraft();
  }
  touch(key, next);
  return { ...next };
}

export function nextDraftRevision(): number {
  revisionSerial += 1;
  return revisionSerial;
}

export function bumpDraftRevision(scope: ComposeDraftScope): number {
  const revision = nextDraftRevision();
  writeStoredDraft(scope, { revision });
  return revision;
}

export function clearDraftStore(): void {
  drafts.clear();
  parkedScopes.clear();
  heldLock = 0;
  busyOwner = 0;
}

export function draftStoreSize(): number {
  return drafts.size;
}
