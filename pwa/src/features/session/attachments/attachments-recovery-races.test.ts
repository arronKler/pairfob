/**
 * Recovery integration races: forget/epochs, in-flight continuations,
 * restore ownership re-checks after the list await, stale identity after a
 * put settles, and reset teardown.
 *
 * Every barrier is deterministic (parked journal gates); the single real-time
 * wait (350 ms) pins that a timer cancelled by reset cannot fire afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import type { LiveSession, PairResult } from "../../../lib/protocol/client";
import type { AttachmentJournalRecord } from "../../../lib/attachment-journal-codec";
import { setPhase, setSessionTransport } from "../../connection/connection-store";
import {
  advertisedAgentKinds,
  applyCapabilities,
  clearCapabilities,
} from "../../operations/capabilities-store";
import { attachLiveSession, setCredential } from "../../computers/catalog-store";
import { selectPane } from "../session-store";
import type { AttachmentScope } from "./attach-model";
import {
  adoptIncoming,
  attachmentScopeKey,
  queueSnapshot,
  removeAttachment,
  replaceRuntimeFile,
  resetAttachmentQueues,
} from "./attachments-store";
import { attachT } from "./attach-copy";
import type { AttachmentJournalBackend } from "./attachments-recovery";
import {
  forgetDaemonAttachments,
  registerAttachmentScope,
  requestRowDelete,
  resetAttachmentRecovery,
  restoreAttachmentScope,
  setAttachmentJournalBackend,
  __pumpAttachmentRecovery,
  __settleAttachmentRecovery,
} from "./attachments-recovery";

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function gate(): Gate {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeJournal implements AttachmentJournalBackend {
  readonly records = new Map<string, AttachmentJournalRecord>();
  readonly events: Array<{ op: string; key: string }> = [];
  parkPuts = false;
  readonly pendingPuts: Array<{ record: AttachmentJournalRecord; gate: Gate }> = [];
  listGate: Gate | null = null;
  clearError: unknown = null;

  private static key(daemonId: string, paneId: string, localId: string): string {
    return `${daemonId}|${paneId}|${localId}`;
  }

  async put(record: AttachmentJournalRecord): Promise<void> {
    this.events.push({ op: "put", key: FakeJournal.key(record.daemonId, record.paneId, record.localId) });
    if (this.parkPuts) {
      const parked = { record, gate: gate() };
      this.pendingPuts.push(parked);
      await parked.gate.promise;
    }
    this.records.set(FakeJournal.key(record.daemonId, record.paneId, record.localId), record);
  }

  async list(daemonId: string, paneId: string): Promise<AttachmentJournalRecord[]> {
    this.events.push({ op: "list", key: FakeJournal.key(daemonId, paneId, "*") });
    if (this.listGate) await this.listGate.promise;
    return [...this.records.values()].filter(
      (record) => record.daemonId === daemonId && record.paneId === paneId,
    );
  }

  async remove(daemonId: string, paneId: string, localId: string): Promise<void> {
    this.events.push({ op: "remove", key: FakeJournal.key(daemonId, paneId, localId) });
    this.records.delete(FakeJournal.key(daemonId, paneId, localId));
  }

  async clearDaemon(daemonId: string): Promise<void> {
    this.events.push({ op: "clear", key: FakeJournal.key(daemonId, "*", "*") });
    if (this.clearError) throw this.clearError;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(`${daemonId}|`)) this.records.delete(key);
    }
  }

  resolveAllPuts(): void {
    for (const parked of this.pendingPuts.splice(0)) parked.gate.resolve();
  }

  rejectAllPuts(error: unknown = new Error("quota")): void {
    for (const parked of this.pendingPuts.splice(0)) parked.gate.reject(error);
  }
}

let fake: FakeJournal;
const scopeD1: AttachmentScope = { daemonId: "d1", paneId: "p1" };
const scopeD2: AttachmentScope = { daemonId: "d2", paneId: "p1" };
const keyD1 = attachmentScopeKey(scopeD1);
const keyD2 = attachmentScopeKey(scopeD2);

function grantUpload(): void {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, upload_file: true }, advertisedAgentKinds());
}

function bringScopeLive(scope: AttachmentScope): void {
  setPhase("live"); setSessionTransport("p2p");
  setCredential({ daemonId: scope.daemonId } as unknown as PairResult);
  attachLiveSession({ tag: `session-${scope.daemonId}` } as unknown as LiveSession);
  selectPane(scope.paneId);
  grantUpload();
}

function binFile(name = "data.bin", size = 10): File {
  return new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
}

function adoptBin(scope: AttachmentScope, file: File = binFile()): string {
  return adoptIncoming(attachmentScopeKey(scope), scope, [file])[0];
}

beforeEach(() => {
  resetAttachmentRecovery();
  resetAttachmentQueues();
  clearCapabilities();
  fake = new FakeJournal();
  setAttachmentJournalBackend(fake);
  bringScopeLive(scopeD1);
  registerAttachmentScope(scopeD1);
});

afterEach(() => {
  resetAttachmentRecovery();
  resetAttachmentQueues();
  clearCapabilities();
  attachLiveSession(null);
  setCredential(null);
  setPhase("connect");
});

describe("forget daemon — epoch and draining", () => {
  test("marks before the await, drains the pending put, then clears only that daemon", async () => {
    // Another daemon's rows and records must survive untouched.
    bringScopeLive(scopeD2);
    registerAttachmentScope(scopeD2);
    const d2Id = adoptBin(scopeD2, binFile("other.bin"));
    await __settleAttachmentRecovery();

    bringScopeLive(scopeD1);
    registerAttachmentScope(scopeD1);
    fake.parkPuts = true;
    const d1Id = adoptBin(scopeD1, binFile("mine.bin"));
    await __pumpAttachmentRecovery();
    expect(fake.pendingPuts).toHaveLength(1);

    const forgetting = forgetDaemonAttachments("d1");
    await Promise.resolve();
    await Promise.resolve();
    // The clear cannot happen until the in-flight put settles.
    expect(fake.events.some((event) => event.op === "clear")).toBe(false);

    fake.resolveAllPuts();
    await forgetting;

    expect(fake.events.map((event) => event.op)).toEqual(["put", "put", "clear"]);
    expect(fake.records.has(`d1|p1|${d1Id}`)).toBe(false);
    expect(fake.records.has(`d2|p1|${d2Id}`)).toBe(true);
    expect(queueSnapshot(keyD1)?.items ?? []).toEqual([]);
    expect(queueSnapshot(keyD2)?.items).toHaveLength(1);
  });

  test("a put rejected during forget is contained, warns nobody, and still clears", async () => {
    fake.parkPuts = true;
    adoptBin(scopeD1);
    await __pumpAttachmentRecovery();

    const forgetting = forgetDaemonAttachments("d1");
    fake.rejectAllPuts(new Error("idb gone"));
    await expect(forgetting).resolves.toBeUndefined();
    expect(fake.events.map((event) => event.op)).toEqual(["put", "clear"]);
  });

  test("clearDaemon failure surfaces a visible queue warning but allows a fresh epoch", async () => {
    adoptBin(scopeD1);
    await __settleAttachmentRecovery();
    fake.clearError = new Error("clear denied");

    await forgetDaemonAttachments("d1");
    expect(queueSnapshot(keyD1)?.notice).toBe(attachT("attach.persistenceFailed"));

    // Re-pair: a brand-new registration under the NEW epoch persists new rows.
    fake.clearError = null;
    bringScopeLive(scopeD1);
    registerAttachmentScope(scopeD1);
    const newId = adoptBin(scopeD1, binFile("after-forget.bin"));
    await __settleAttachmentRecovery();
    expect(fake.records.has(`d1|p1|${newId}`)).toBe(true);
    expect(fake.events.some((event) => event.op === "put")).toBe(true);
  });
});

describe("restore — post-await ownership and epoch re-checks", () => {
  test("any session/scope/cap change while the list is pending restores nothing", async () => {
    const seedRecord = await captureSeedRecord();
    const changes: Array<[string, () => void] > = [
      ["phase leaves live", () => setPhase("connect")],
      ["pane switches", () => selectPane("p9")],
      ["capability revoked", () => clearCapabilities()],
      ["session swaps", () => attachLiveSession({ tag: "other" } as unknown as LiveSession)],
    ];
    for (const [label, change] of changes) {
      resetAttachmentRecovery();
      resetAttachmentQueues();
      const local = new FakeJournal();
      local.records.set(recordKey(seedRecord), seedRecord);
      setAttachmentJournalBackend(local);
      bringScopeLive(scopeD1);
      registerAttachmentScope(scopeD1);

      local.listGate = gate();
      const restoring = restoreAttachmentScope(scopeD1);
      await Promise.resolve();
      change();
      local.listGate.resolve();
      const count = await restoring;
      expect(count, label).toBe(0);
      expect(queueSnapshot(keyD1)?.items ?? [], label).toEqual([]);
      grantUpload(); // restore capability for the next iteration if it was cleared
    }
  });

  test("a forget landing while the list is pending restores nothing", async () => {
    const seedRecord = await captureSeedRecord();
    resetAttachmentRecovery();
    resetAttachmentQueues();
    const local = new FakeJournal();
    local.records.set(recordKey(seedRecord), seedRecord);
    setAttachmentJournalBackend(local);
    bringScopeLive(scopeD1);
    registerAttachmentScope(scopeD1);

    local.listGate = gate();
    const restoring = restoreAttachmentScope(scopeD1);
    await Promise.resolve();
    await forgetDaemonAttachments("d1");
    local.listGate.resolve();
    expect(await restoring).toBe(0);
  });

  test("valid restore touches only list, keeps exact Files/cp, and live rows win", async () => {
    const seedRecord = await captureSeedRecord();
    resetAttachmentRecovery();
    resetAttachmentQueues();
    const local = new FakeJournal();
    local.records.set(recordKey(seedRecord), seedRecord);
    setAttachmentJournalBackend(local);
    bringScopeLive(scopeD1);
    registerAttachmentScope(scopeD1);

    const count = await restoreAttachmentScope(scopeD1);
    expect(count).toBe(1);
    await __settleAttachmentRecovery(); // restored signature must cause no rewrite
    expect(local.events.map((event) => event.op)).toEqual(["list"]);

    const items = queueSnapshot(keyD1)?.items ?? [];
    expect(items).toHaveLength(1);
    const restored = items[0];
    expect(restored.localId).toBe(seedRecord.localId);
    expect(restored.status).toBe("queued");
    expect(restored.restored).toBe(true);

    // Second restore collides with the live row: live rows always win.
    expect(await restoreAttachmentScope(scopeD1)).toBe(0);
    expect(local.events.map((event) => event.op)).toEqual(["list", "list"]);
  });

  test("a tombstoned id is not resurrected even if its record reappears", async () => {
    const recordA = await captureSeedRecord(binFile("a.bin"));
    const recordB = await captureSeedRecord(binFile("b.bin"));
    resetAttachmentRecovery();
    resetAttachmentQueues();
    const local = new FakeJournal();
    setAttachmentJournalBackend(local);
    bringScopeLive(scopeD1);
    registerAttachmentScope(scopeD1);

    // A was deleted earlier this session: the delete is a session-long
    // tombstone even though the backend currently holds no such record...
    await requestRowDelete(scopeD1, recordA.localId);
    // ...then the record reappears in the backend before listing.
    local.records.set(recordKey(recordA), recordA);
    local.records.set(recordKey(recordB), recordB);

    const count = await restoreAttachmentScope(scopeD1);
    expect(count).toBe(1);
    const restoredIds = (queueSnapshot(keyD1)?.items ?? []).map((item) => item.localId);
    expect(restoredIds).toEqual([recordB.localId]);
    expect(restoredIds).not.toContain(recordA.localId);
  });
});

describe("post-await identity", () => {
  test("a source replaced while a put is pending writes both states and ends on the new File", async () => {
    fake.parkPuts = true;
    const first = binFile("first.bin", 11);
    const localId = adoptBin(scopeD1, first);
    await __pumpAttachmentRecovery(); // old state put parked
    expect(fake.pendingPuts).toHaveLength(1);

    const edited = binFile("edited.bin", 22);
    replaceRuntimeFile(keyD1, localId, edited);
    await __pumpAttachmentRecovery(); // new signature enqueued BEHIND the tail
    // Per-row serialization: the second backend call cannot start while the
    // first put is parked, but its record was captured at enqueue time.
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);
    expect(fake.pendingPuts).toHaveLength(1);

    fake.resolveAllPuts(); // first put settles; the queued one now reaches
    await __pumpAttachmentRecovery(); // the backend and parks
    expect(fake.pendingPuts).toHaveLength(1);
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(2);
    fake.resolveAllPuts();
    await __settleAttachmentRecovery();

    const puts = fake.events.filter((event) => event.op === "put");
    expect(puts).toHaveLength(2);
    const finalRecord = fake.records.get(`d1|p1|${localId}`);
    expect(finalRecord).toBeTruthy();
    expect(finalRecord!.sourceFile).toBe(edited);
    expect(finalRecord!.uploadFile).toBe(edited);
    expect(finalRecord!.sourceFile).not.toBe(first);
    // No failure warning from either continuation.
    const item = queueSnapshot(keyD1)?.items.find((candidate) => candidate.localId === localId);
    expect(item?.persistenceWarning ?? "").toBe("");
  });

  test("a row removed while its put is pending still reaches a final backend delete", async () => {
    fake.parkPuts = true;
    const localId = adoptBin(scopeD1);
    await __pumpAttachmentRecovery();

    // Simulate the store-side removal (controller's delete hook normally
    // calls requestRowDelete too); the vanished-row flush backstop must order
    // a delete behind the pending put even for a never-saved row.
    removeAttachment(keyD1, localId);
    await __pumpAttachmentRecovery();
    expect(fake.events.filter((event) => event.op === "remove")).toHaveLength(0);

    fake.resolveAllPuts();
    await __settleAttachmentRecovery();
    expect(fake.events.map((event) => event.op)).toEqual(["put", "remove"]);
    expect(fake.records.has(`d1|p1|${localId}`)).toBe(false);
  });
});

describe("reset teardown", () => {
  test("an in-flight put settling after reset cannot warn into or patch fresh state", async () => {
    fake.parkPuts = true;
    const localId = adoptBin(scopeD1);
    await __pumpAttachmentRecovery();

    resetAttachmentRecovery(); // invalidates the old continuation's epoch
    fake.resolveAllPuts();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const item = queueSnapshot(keyD1)?.items.find((candidate) => candidate.localId === localId);
    expect(item?.persistenceWarning ?? "").toBe("");
  });

  test("a debounced flush timer pending at reset never fires later", async () => {
    // Adopt WITHOUT settling: only the 300 ms subscription timer is armed.
    adoptBin(scopeD1);
    resetAttachmentRecovery();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fake.events).toEqual([]);
  });
});

// --- helpers for building journal seeds through the real pipeline -----------------

function recordKey(record: AttachmentJournalRecord): string {
  return `${record.daemonId}|${record.paneId}|${record.localId}`;
}

/**
 * Persist one row through the real recovery pipeline in the current fake and
 * return the exact stored record (used as a reload/restore seed).
 */
async function captureSeedRecord(file: File = binFile("seed.bin")): Promise<AttachmentJournalRecord> {
  const localId = adoptBin(scopeD1, file);
  await __settleAttachmentRecovery();
  const record = fake.records.get(`d1|p1|${localId}`);
  if (!record) throw new Error("seed record was not persisted");
  return record;
}

test("a delayed journal list cannot restore into another Herdr session on the same connection", async () => {
  const record = await captureSeedRecord();
  resetAttachmentRecovery();
  resetAttachmentQueues();
  setAttachmentJournalBackend(fake);
  fake.records.set(recordKey(record), record);
  let herd: string | null = null;
  attachLiveSession({ herdSession: () => herd } as unknown as LiveSession);
  fake.listGate = gate();
  const pending = restoreAttachmentScope(scopeD1);
  await __pumpAttachmentRecovery();
  herd = "work";
  fake.listGate.resolve();
  expect(await pending).toBe(0);
  expect(queueSnapshot(keyD1)?.items ?? []).toEqual([]);
});
