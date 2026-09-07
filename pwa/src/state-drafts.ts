import { composeDraftKey, type ComposeDraftScope } from "./lib/compose-draft-scope";

/** Bounded in-memory compose drafts. Prompt text never goes to localStorage. */
const MAX_DRAFTS = 32;

export type StoredComposeDraft = {
  text: string;
  error: string;
};

const emptyDraft = (): StoredComposeDraft => ({ text: "", error: "" });

const drafts = new Map<string, StoredComposeDraft>();
let viewGeneration = 0;
let lockSerial = 0;
let heldLock = 0;

function touch(key: string, entry: StoredComposeDraft): void {
  drafts.delete(key);
  drafts.set(key, entry);
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (typeof oldest !== "string") break;
    drafts.delete(oldest);
  }
}

export function currentViewGeneration(): number {
  return viewGeneration;
}

/** Session/computer identity for async results. Pane switches keep this value. */
export function bumpViewGeneration(): number {
  heldLock = 0;
  viewGeneration += 1;
  return viewGeneration;
}

export function nextPromptLockId(): number {
  lockSerial += 1;
  return lockSerial;
}

export function holdPromptLock(id: number): void {
  heldLock = id;
}

export function releasePromptLock(id: number): boolean {
  if (heldLock !== id) return false;
  heldLock = 0;
  return true;
}

export function promptLockHeld(id: number): boolean {
  return heldLock === id;
}

export function dropPromptLocks(): void {
  heldLock = 0;
}

export function readStoredDraft(scope: ComposeDraftScope): StoredComposeDraft {
  const entry = drafts.get(composeDraftKey(scope));
  return entry ? { ...entry } : emptyDraft();
}

export function writeStoredDraft(scope: ComposeDraftScope, patch: Partial<StoredComposeDraft>): StoredComposeDraft {
  const key = composeDraftKey(scope);
  const next = { ...readStoredDraft(scope), ...patch };
  if (!next.text && !next.error) {
    drafts.delete(key);
    return emptyDraft();
  }
  touch(key, next);
  return { ...next };
}

export function clearDraftStore(): void {
  drafts.clear();
  heldLock = 0;
}

export function draftStoreSize(): number {
  return drafts.size;
}

export function draftStoreUsesLocalStorage(storage: Storage): boolean {
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.includes("composeDraft") || key?.includes("promptDraft")) return true;
  }
  return false;
}
