/**
 * Recovery integration — ordered write/delete bookkeeping, signature
 * de-duplication, exact-record persistence and the visible failure warning.
 *
 * Deterministic barriers only: the fake journal parks puts on deferred
 * gates and __settleAttachmentRecovery() flushes without the 300 ms timer.
 * No real time waits except the one warning-feedback test (which must prove
 * the debounced publication itself stays quiet).
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
  patchItem,
  queueSnapshot,
  resetAttachmentQueues,
  runtimeSourceFile,
  replaceRuntimeFile,
  setRuntimeCheckpoint,
} from "./attachments-store";
import { attachT } from "./attach-copy";
import type { AttachmentJournalBackend } from "./attachments-recovery";
import {
  backend,
  persistAttachmentCheckpoint,
  registerAttachmentScope,
  restoreAttachmentScope,
  requestRowDelete,
  resetAttachmentRecovery,
  scheduleAttachmentPersist,
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

type JournalEvent = { op: "put" | "remove" | "clear" | "list"; key: string };

class FakeJournal implements AttachmentJournalBackend {
  readonly records = new Map<string, AttachmentJournalRecord>();
  readonly events: JournalEvent[] = [];
  /** When true, every put parks here instead of storing immediately. */
  parkPuts = false;
  readonly pendingPuts: Array<{ record: AttachmentJournalRecord; gate: Gate }> = [];
  /** When set, list() awaits this gate. */
  listGate: Gate | null = null;
  /** When set, clearDaemon() awaits this gate. */
  clearGate: Gate | null = null;
  /** Instant clearDaemon rejection. */
  clearError: unknown = null;

  private static key(daemonId: string, paneId: string, localId: string): string {
    return `${daemonId}|${paneId}|${localId}`;
  }

  async put(record: AttachmentJournalRecord): Promise<void> {
    const key = FakeJournal.key(record.daemonId, record.paneId, record.localId);
    this.events.push({ op: "put", key });
    if (this.parkPuts) {
      const parked = { record, gate: gate() };
      this.pendingPuts.push(parked);
      await parked.gate.promise;
    }
    this.records.set(key, record);
  }

  async list(daemonId: string, paneId: string): Promise<AttachmentJournalRecord[]> {
    this.events.push({ op: "list", key: FakeJournal.key(daemonId, paneId, "*") });
    if (this.listGate) await this.listGate.promise;
    return [...this.records.values()].filter(
      (record) => record.daemonId === daemonId && record.paneId === paneId,
    );
  }

  async remove(daemonId: string, paneId: string, localId: string): Promise<void> {
    const key = FakeJournal.key(daemonId, paneId, localId);
    this.events.push({ op: "remove", key });
    this.records.delete(key);
  }

  async clearDaemon(daemonId: string): Promise<void> {
    this.events.push({ op: "clear", key: FakeJournal.key(daemonId, "*", "*") });
    if (this.clearGate) await this.clearGate.promise;
    if (this.clearError) throw this.clearError;
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(`${daemonId}|`)) this.records.delete(key);
    }
  }

  resolveAllPuts(): void {
    const pending = this.pendingPuts.splice(0);
    for (const parked of pending) parked.gate.resolve();
  }

  rejectAllPuts(error: unknown = new Error("quota")): void {
    const pending = this.pendingPuts.splice(0);
    for (const parked of pending) parked.gate.reject(error);
  }
}

let fake: FakeJournal;

const scopeD1: AttachmentScope = { daemonId: "d1", paneId: "p1" };
const keyD1 = attachmentScopeKey(scopeD1);

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

/** Adopt a non-image row (no thumbnail worker) and return its local id. */
function adoptBin(scope: AttachmentScope, file: File = binFile()): string {
  return adoptIncoming(attachmentScopeKey(scope), scope, [file])[0];
}

function itemOf(localId: string) {
  return queueSnapshot(keyD1)?.items.find((item) => item.localId === localId);
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

test("named-session journal save, restore and delete keep the default session's records", async () => {
  const defaultId = adoptBin(scopeD1, binFile("default.bin"));
  await __settleAttachmentRecovery();
  let herd: string | null = "work";
  attachLiveSession({ herdSession: () => herd } as unknown as LiveSession);
  const workScope: AttachmentScope = { ...scopeD1, herdSession: "work" };
  const workKey = attachmentScopeKey(workScope);
  registerAttachmentScope(workScope);
  const workId = adoptBin(workScope, binFile("work.bin"));
  await __settleAttachmentRecovery();
  expect(fake.records.has(`d1|p1|${defaultId}`)).toBe(true);
  expect(fake.records.has(`d1:herd:work|p1|${workId}`)).toBe(true);

  resetAttachmentRecovery();
  resetAttachmentQueues();
  setAttachmentJournalBackend(fake);
  herd = "other";
  expect(await restoreAttachmentScope({ ...scopeD1, herdSession: "other" })).toBe(0);
  herd = "work";
  expect(await restoreAttachmentScope(workScope)).toBe(1);
  expect(queueSnapshot(workKey)?.items.map(item => item.name)).toEqual(["work.bin"]);
  herd = null;
  expect(await restoreAttachmentScope(scopeD1)).toBe(1);
  expect(queueSnapshot(keyD1)?.items.map(item => item.name)).toEqual(["default.bin"]);
  await requestRowDelete(workScope, workId);
  expect(fake.records.has(`d1:herd:work|p1|${workId}`)).toBe(false);
  expect(fake.records.has(`d1|p1|${defaultId}`)).toBe(true);
});

describe("ordered save / delete", () => {
  test("save then requestRowDelete reaches the backend despite the tombstone", async () => {
    const file = binFile();
    const localId = adoptBin(scopeD1, file);
    await __settleAttachmentRecovery();

    const recordKey = `d1|p1|${localId}`;
    expect(fake.records.has(recordKey)).toBe(true);
    expect(fake.events.map((event) => event.op)).toEqual(["put"]);

    await requestRowDelete(scopeD1, localId);
    expect(fake.records.has(recordKey)).toBe(false);
    expect(fake.events.map((event) => `${event.op}:${event.key === recordKey ? "row" : event.key}`)).toEqual([
      "put:row",
      "remove:row",
    ]);
  });

  test("a delete queued behind a pending put leaves the backend absent; queued puts self-skip", async () => {
    fake.parkPuts = true;
    const localId = adoptBin(scopeD1);
    await __pumpAttachmentRecovery();
    expect(fake.pendingPuts).toHaveLength(1);
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);

    // More publications while the first Blob write is pending must never
    // enqueue a second write for the same signature.
    scheduleAttachmentPersist(scopeD1, localId);
    await __pumpAttachmentRecovery();
    scheduleAttachmentPersist(scopeD1, localId);
    await __pumpAttachmentRecovery();
    expect(fake.pendingPuts).toHaveLength(1);
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);

    // Delete is ordered BEHIND the pending put; it is not dropped by the
    // tombstone that requestRowDelete records immediately.
    const deleted = requestRowDelete(scopeD1, localId);
    await Promise.resolve();
    expect(fake.events.filter((event) => event.op === "remove")).toHaveLength(0); // still behind put
    fake.resolveAllPuts();
    await deleted;
    await __settleAttachmentRecovery();

    expect(fake.records.has(`d1|p1|${localId}`)).toBe(false);
    expect(fake.events.map((event) => event.op)).toEqual(["put", "remove"]);
  });

  test("a terminal row is deleted even if it was never successfully saved", async () => {
    fake.parkPuts = true;
    const localId = adoptBin(scopeD1);
    await __pumpAttachmentRecovery(); // put pending, never resolved yet

    const deleted = requestRowDelete(scopeD1, localId);
    fake.rejectAllPuts(new Error("unavailable")); // first put fails
    await deleted;
    await __pumpAttachmentRecovery();
    expect(fake.events.map((event) => event.op)).toEqual(["put", "remove"]);
    expect(fake.records.has(`d1|p1|${localId}`)).toBe(false);
  });

  test("repeated delete requests enqueue at most one backend remove", async () => {
    const localId = adoptBin(scopeD1);
    await __settleAttachmentRecovery();
    await requestRowDelete(scopeD1, localId);
    await requestRowDelete(scopeD1, localId);
    await requestRowDelete(scopeD1, localId);
    expect(fake.events.filter((event) => event.op === "remove")).toHaveLength(1);
  });
});

describe("signature de-duplication", () => {
  test("repeated progress publications while a put is pending write the Blob once", async () => {
    fake.parkPuts = true;
    const localId = adoptBin(scopeD1);
    await __pumpAttachmentRecovery();

    for (const acknowledged of [1, 2, 3, 4]) {
      patchItem(keyD1, localId, { acknowledged });
      await __pumpAttachmentRecovery();
    }
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);

    fake.resolveAllPuts();
    await __settleAttachmentRecovery();
    // Post-acknowledgement publications after the save do not rewrite either:
    // the projected row is unchanged and its signature is already saved.
    patchItem(keyD1, localId, { acknowledged: 5 });
    await __settleAttachmentRecovery();
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);
  });

  test("a failed save is visible but warning-driven flushes never retry the same bytes", async () => {
    fake.parkPuts = true;
    const localId = adoptBin(scopeD1);
    await __pumpAttachmentRecovery();
    fake.rejectAllPuts(new Error("quota exceeded"));
    await __settleAttachmentRecovery();

    expect(itemOf(localId)?.persistenceWarning).toBe(attachT("attach.persistenceFailed"));
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);

    // Immediate re-flush (same signature): no new attempt.
    await __settleAttachmentRecovery();
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);

    // The subscription publish caused by the warning patch also schedules the
    // real 300 ms debounced flush; wait for it and confirm it stays quiet.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);

    // A genuinely new signature (the checkpoint arrives) gets one new attempt,
    // and success clears the visible warning.
    fake.parkPuts = false;
    const file = runtimeSourceFile(keyD1, localId);
    expect(file).not.toBeNull();
    setRuntimeCheckpoint(keyD1, localId, {
      uploadId: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
      paneId: "p1",
      name: file!.name,
      size: file!.size,
      sha256: "a".repeat(64),
      mime: file!.type,
    });
    await persistAttachmentCheckpoint(scopeD1, localId);
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(2);
    expect(itemOf(localId)?.persistenceWarning ?? "").toBe("");
  });
});

describe("exact record and the checkpoint barrier", () => {
  test("persistAttachmentCheckpoint blocks until the put settles with exact Files and cp", async () => {
    fake.parkPuts = true;
    const file = binFile("photo.bin", 123);
    const localId = adoptBin(scopeD1, file);
    const checkpoint = {
      uploadId: "11111111-2222-3333-4444-555555555555",
      paneId: "p1",
      name: file.name,
      size: file.size,
      sha256: "b".repeat(64),
      mime: file.type,
    };
    setRuntimeCheckpoint(keyD1, localId, checkpoint);

    let settled = false;
    const done = persistAttachmentCheckpoint(scopeD1, localId).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // caller is blocked behind the pending put
    expect(fake.pendingPuts).toHaveLength(1);

    fake.resolveAllPuts();
    await done;

    const stored = fake.records.get(`d1|p1|${localId}`);
    expect(stored).toBeTruthy();
    expect(stored!.sourceFile).toBe(file); // exact File objects, not copies
    expect(stored!.uploadFile).toBe(file);
    expect(stored!.checkpoint).toEqual(checkpoint);
    expect(stored!.item.name).toBe(file.name);
    expect(stored!.item.acknowledged).toBe(0); // attempt state never journaled
    expect(stored!.item.scheduled).toBe(false);
  });

  test("a rejected checkpoint put warns on the row but still resolves (upload allowed)", async () => {
    fake.parkPuts = true;
    const localId = adoptBin(scopeD1);
    const pending = persistAttachmentCheckpoint(scopeD1, localId);
    await __pumpAttachmentRecovery();
    expect(fake.pendingPuts).toHaveLength(1);
    fake.rejectAllPuts(new Error("idb unavailable"));
    await expect(pending).resolves.toBeUndefined(); // never rejects into the transfer
    expect(itemOf(localId)?.persistenceWarning).toBe(attachT("attach.persistenceFailed"));
    expect(fake.events.filter((event) => event.op === "put")).toHaveLength(1);
  });
});

describe("backend seam", () => {
  test("the default backend is the real journal; null restores it; getter exposes current", () => {
    const current = backend();
    expect(current).toBe(fake); // installed by beforeEach
    expect(setAttachmentJournalBackend(null)).not.toBe(fake);
    expect(backend()).not.toBe(fake); // real native journal backend restored
    setAttachmentJournalBackend(fake);
    expect(backend()).toBe(fake);
  });
});


describe("checkpoint operation identity", () => {
  test.each([false, true])("A/B/A revert waits for the final A (initial A saved=%s)", async (initialSaved) => {
    const a = binFile("a.bin"), b = binFile("b.bin");
    const id = adoptBin(scopeD1, a);
    fake.parkPuts = !initialSaved;
    const first = persistAttachmentCheckpoint(scopeD1, id);
    await __pumpAttachmentRecovery();
    if (initialSaved) await first;
    fake.parkPuts = true;
    const replace = (file: File) => {
      replaceRuntimeFile(keyD1, id, file);
      patchItem(keyD1, id, { name: file.name, size: file.size, mime: file.type });
    };
    replace(b);
    const middle = persistAttachmentCheckpoint(scopeD1, id);
    await __pumpAttachmentRecovery();
    replace(a);
    let finalDone = false, duplicateDone = false;
    const last = persistAttachmentCheckpoint(scopeD1, id).then(() => { finalDone = true; });
    await __pumpAttachmentRecovery();
    expect(finalDone).toBe(false);
    if (!initialSaved) { fake.resolveAllPuts(); await __pumpAttachmentRecovery(); }
    const duplicate = persistAttachmentCheckpoint(scopeD1, id).then(() => { duplicateDone = true; });
    await __pumpAttachmentRecovery();
    expect(duplicateDone).toBe(false);
    // B is the only active put; progress must not schedule another Blob write.
    patchItem(keyD1, id, { acknowledged: 1 });
    fake.resolveAllPuts();
    await __pumpAttachmentRecovery();
    expect(finalDone).toBe(false);
    expect(duplicateDone).toBe(false);
    expect(fake.pendingPuts).toHaveLength(1);
    expect(fake.pendingPuts[0].record.sourceFile).toBe(a);
    fake.resolveAllPuts();
    await Promise.all([first, middle, last, duplicate]);
    await __settleAttachmentRecovery();
    expect(fake.records.get(`d1|p1|${id}`)?.sourceFile).toBe(a);
    expect(fake.events.filter(e => e.op === "put")).toHaveLength(3);
  });
});
