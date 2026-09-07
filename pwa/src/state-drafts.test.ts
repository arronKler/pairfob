import { describe, expect, test } from "bun:test";
import {
  bumpViewGeneration,
  clearDraftStore,
  currentViewGeneration,
  draftStoreSize,
  dropPromptLocks,
  holdPromptLock,
  nextPromptLockId,
  promptLockHeld,
  readStoredDraft,
  releasePromptLock,
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

  test("empty text and error forget the entry", () => {
    clearDraftStore();
    writeStoredDraft(scope("p1"), { text: "secret", error: "failed" });
    writeStoredDraft(scope("p1"), { text: "", error: "" });
    expect(draftStoreSize()).toBe(0);
    expect(readStoredDraft(scope("p1"))).toEqual({ text: "", error: "" });
  });

  test("same pane id on another computer is a different slot", () => {
    clearDraftStore();
    writeStoredDraft(scope("p1", "daemon-a"), { text: "alpha" });
    writeStoredDraft(scope("p1", "daemon-b"), { text: "beta" });
    expect(readStoredDraft(scope("p1", "daemon-a")).text).toBe("alpha");
    expect(readStoredDraft(scope("p1", "daemon-b")).text).toBe("beta");
  });

  test("view generation advances and drops the held lock", () => {
    clearDraftStore();
    const first = currentViewGeneration();
    const lock = nextPromptLockId();
    holdPromptLock(lock);
    expect(promptLockHeld(lock)).toBe(true);
    expect(bumpViewGeneration()).toBe(first + 1);
    expect(promptLockHeld(lock)).toBe(false);
    expect(releasePromptLock(lock)).toBe(false);
  });

  test("releasing one lock does not drop a later lock", () => {
    clearDraftStore();
    dropPromptLocks();
    const first = nextPromptLockId();
    const second = nextPromptLockId();
    holdPromptLock(first);
    holdPromptLock(second);
    expect(releasePromptLock(first)).toBe(false);
    expect(promptLockHeld(second)).toBe(true);
    expect(releasePromptLock(second)).toBe(true);
    expect(promptLockHeld(second)).toBe(false);
  });
});
