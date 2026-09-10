import { describe, expect, test } from "bun:test";
import {
  bumpViewIncarnation,
  clearDraftStore,
  currentViewIncarnation,
  draftStoreSize,
  dropPromptLocks,
  bumpDraftRevision,
  holdPromptLock,
  nextDraftRevision,
  nextPromptLockId,
  parkStoredDraft,
  promptLockHeld,
  readStoredDraft,
  releasePromptLock,
  storedDraftIsParked,
  unstickPromptBusy,
  writeStoredDraft,
} from "./state-drafts";

const scope = (paneId: string, daemonId = "daemon-a") => ({
  daemonId,
  paneId,
  mode: "agent" as const,
});

describe("in-memory compose drafts", () => {
  test("stores text and error per daemon/pane/mode and drops the oldest past 32", () => {
    clearDraftStore();
    writeStoredDraft(scope("keep"), { text: "oldest kept until overflow" });
    for (let i = 0; i < 32; i++) writeStoredDraft(scope(`p${i}`), { text: `draft-${i}` });
    expect(draftStoreSize()).toBe(32);
    expect(readStoredDraft(scope("keep")).text).toBe("");
    expect(readStoredDraft(scope("p31")).text).toBe("draft-31");
  });

  test("empty text and error with no revision forget the entry", () => {
    clearDraftStore();
    writeStoredDraft(scope("p1"), { text: "secret", error: "failed" });
    writeStoredDraft(scope("p1"), { text: "", error: "" });
    expect(draftStoreSize()).toBe(0);
    expect(readStoredDraft(scope("p1"))).toEqual({ text: "", error: "", revision: 0 });
  });

  test("an in-flight revision keeps the slot after text is cleared", () => {
    clearDraftStore();
    writeStoredDraft(scope("p1"), { text: "", error: "", revision: 4 });
    expect(draftStoreSize()).toBe(1);
    expect(readStoredDraft(scope("p1")).revision).toBe(4);
  });

  test("same pane id on another computer is a different slot", () => {
    clearDraftStore();
    writeStoredDraft(scope("p1", "daemon-a"), { text: "alpha" });
    writeStoredDraft(scope("p1", "daemon-b"), { text: "beta" });
    expect(readStoredDraft(scope("p1", "daemon-a")).text).toBe("alpha");
    expect(readStoredDraft(scope("p1", "daemon-b")).text).toBe("beta");
  });

  test("view incarnation advances without dropping the held lock", () => {
    clearDraftStore();
    const first = currentViewIncarnation();
    const lock = nextPromptLockId();
    holdPromptLock(lock);
    expect(promptLockHeld(lock)).toBe(true);
    expect(unstickPromptBusy()).toBe(true);
    expect(bumpViewIncarnation()).toBe(first + 1);
    expect(promptLockHeld(lock)).toBe(true);
    expect(unstickPromptBusy()).toBe(false);
    expect(releasePromptLock(lock)).toEqual({ owned: true, clearedBusy: false });
  });

  test("revisions stay monotonic after LRU eviction of the same scope", () => {
    clearDraftStore();
    const first = bumpDraftRevision(scope("p1"));
    writeStoredDraft(scope("p1"), { text: "old attempt", revision: first });
    for (let i = 0; i < 32; i++) writeStoredDraft(scope(`evict-${i}`), { text: `x${i}` });
    expect(readStoredDraft(scope("p1")).revision).toBe(0);
    clearDraftStore();
    const second = bumpDraftRevision(scope("p1"));
    expect(second).toBeGreaterThan(first);
    expect(second).not.toBe(first);
    expect(nextDraftRevision()).toBeGreaterThan(second);
  });

  test("releasing one lock does not drop a later lock", () => {
    clearDraftStore();
    dropPromptLocks();
    const first = nextPromptLockId();
    const second = nextPromptLockId();
    holdPromptLock(first);
    holdPromptLock(second);
    expect(releasePromptLock(first)).toEqual({ owned: false, clearedBusy: false });
    expect(promptLockHeld(second)).toBe(true);
    expect(releasePromptLock(second)).toEqual({ owned: true, clearedBusy: true });
    expect(promptLockHeld(second)).toBe(false);
  });

  test("a parked mark retires with its stored draft on deletion, eviction and reset", () => {
    clearDraftStore();
    writeStoredDraft(scope("p1"), { text: "parked" });
    parkStoredDraft(scope("p1"));
    expect(storedDraftIsParked(scope("p1"))).toBe(true);
    // Empty-entry deletion drops the mark with the entry.
    writeStoredDraft(scope("p1"), { text: "", error: "", revision: 0 });
    expect(readStoredDraft(scope("p1")).text).toBe("");
    expect(storedDraftIsParked(scope("p1"))).toBe(false);
    // LRU eviction past the 32-slot bound drops it too.
    writeStoredDraft(scope("p1"), { text: "parked again" });
    parkStoredDraft(scope("p1"));
    for (let i = 0; i < 32; i++) writeStoredDraft(scope(`evict-${i}`), { text: `x${i}` });
    expect(readStoredDraft(scope("p1")).text).toBe("");
    expect(storedDraftIsParked(scope("p1"))).toBe(false);
    // A recreated scope has no stale protection from the evicted mark.
    writeStoredDraft(scope("p1"), { text: "fresh draft" });
    expect(storedDraftIsParked(scope("p1"))).toBe(false);
    // A full reset clears every mark.
    parkStoredDraft(scope("p1"));
    clearDraftStore();
    expect(draftStoreSize()).toBe(0);
    expect(storedDraftIsParked(scope("p1"))).toBe(false);
  });
});
