import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AttachmentItem, AttachmentCheckpoint } from "./attach-model";
import type { AttachmentJournalRecord } from "../../../lib/attachment-journal-codec";
import { attachmentScopeKey, queueSnapshot, resetAttachmentQueues, restoreAttachmentRecord, runtimeAbort, runtimeCheckpoint, runtimeFile, runtimeGeneration, runtimeObjectUrl, runtimePhotoOrigin, runtimePreparedImage, runtimeSourceFile } from "./attachments-store";
import { setThumbnailPreparer } from "./attachments-thumbnails";
import { resetAttachmentRecovery } from "./attachments-recovery";
import { waitFor } from "../../../../test-support/wait";

const scopeA = { daemonId: "d1", paneId: "p1" };
const keyA = attachmentScopeKey(scopeA);

let issued = 0;
let revoked = 0;
let createdFrom: Blob[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

function fakeFile(name: string, size: number, type = ""): File {
  const chunk = new Uint8Array(size);
  return new File([chunk], name, { type });
}

/**
 * Let the serial thumbnail queue's timer/microtask chain fully settle. Generous
 * on purpose: a busy event loop (the whole attachments suite in one process)
 * can delay the chain past a few milliseconds.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** Abort-aware thumbnail fake: a small JPEG/PNG blob, never the source File. */
function abortAwareThumbnail(file: File, options?: { signal?: AbortSignal }): Promise<Blob | null> {
  const error = new DOMException("aborted", "AbortError");
  if (options?.signal?.aborted) return Promise.reject(error);
  return new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(error), { once: true });
    setTimeout(() => {
      const type = file.type === "image/png" ? "image/png" : "image/jpeg";
      resolve(new Blob([new Uint8Array([0x10, 0x20, 0x30, 0x40])], { type }));
    }, 0);
  });
}

beforeEach(() => {
  issued = 0;
  revoked = 0;
  createdFrom = [];
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    createdFrom.push(blob as Blob);
    return `blob:test/${++issued}`;
  };
  URL.revokeObjectURL = () => { revoked += 1; };
  // Journal work left running by an earlier suite (a late failed delete writes
  // a pane notice) must not land in these queues.
  resetAttachmentRecovery();
  resetAttachmentQueues();
  setThumbnailPreparer(abortAwareThumbnail);
});

afterEach(() => {
  setThumbnailPreparer(null);
  resetAttachmentQueues();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

let restoreSeq = 0;

function journalRecord(input: {
  source: File;
  upload?: File;
  localId?: string;
  item?: Partial<AttachmentItem>;
  checkpoint?: AttachmentCheckpoint;
  daemonId?: string;
  paneId?: string;
}): AttachmentJournalRecord {
  const source = input.source;
  const upload = input.upload ?? source;
  const localId = input.localId ?? `att_restore_${++restoreSeq}`;
  const item: AttachmentItem = {
    localId,
    kind: source.type.startsWith("image/") ? "image" : "file",
    name: upload.name,
    size: upload.size,
    mime: upload.type ?? "",
    status: "queued",
    acknowledged: 0,
    errorText: "",
    recoverable: false,
    path: "",
    inserted: false,
    editNote: "",
    cancelIntent: false,
    ...input.item,
  };
  const record: AttachmentJournalRecord = {
    version: 1,
    daemonId: input.daemonId ?? "d1",
    paneId: input.paneId ?? "p1",
    localId,
    updatedAt: Date.now(),
    sourceFile: source,
    uploadFile: upload,
    item,
  };
  if (input.checkpoint) record.checkpoint = input.checkpoint;
  return record;
}

describe("restoreAttachmentRecord", () => {
  test("restores exact source/upload and intent for a queued row without scheduling anything", async () => {
    const source = fakeFile("photo.jpg", 1000, "image/jpeg");
    const upload = fakeFile("photo.jpg", 400, "image/jpeg");
    const record = journalRecord({
      source, upload,
      item: {
        status: "uploading", acknowledged: 250, recoverable: true,
        compressionMode: "smart", imageIntent: "detail", originalBytes: 1000,
        scheduled: true, transferPhase: "sending", compressing: true,
        speedBps: 999, etaSeconds: 5, waiting: true, stageTimings: { sending: 12 },
      },
    });
    expect(restoreAttachmentRecord(record)).toBe(true);
    const id = record.localId;
    expect(runtimeSourceFile(keyA, id)).toBe(source); // exact saved File objects
    expect(runtimeFile(keyA, id)).toBe(upload);
    expect(runtimeCheckpoint(keyA, id)).toBeNull();
    expect(runtimePreparedImage(keyA, id)).toBeNull();
    expect(runtimeGeneration(keyA, id)).toBe(0); // nothing claimed
    expect(runtimeAbort(keyA, id)).toBeNull(); // nothing scheduled
    const item = queueSnapshot(keyA)?.items.find((row) => row.localId === id)!;
    expect(item).toMatchObject({
      status: "queued", recoverable: false, acknowledged: 0,
      imageIntent: "detail", compressionMode: "smart", restored: true,
    });
    expect(item.scheduled).toBe(false);
    expect(item.compressing).toBe(false);
    expect(item.transferPhase).toBeUndefined();
    expect(item.speedBps).toBeUndefined();
    expect(item.etaSeconds).toBeUndefined();
    expect(item.waiting).toBeUndefined();
    expect(item.stageTimings).toBeUndefined();
    await waitFor(() => createdFrom.length === 1, "the restored row's thumbnail");
    // Nothing auto-starts: the row is still queued once its thumbnail exists.
    expect(queueSnapshot(keyA)?.items.find((row) => row.localId === id)?.status).toBe("queued");
    expect(runtimeGeneration(keyA, id)).toBe(0);
    expect(createdFrom).toHaveLength(1); // its thumbnail renders from the SOURCE
  });

  test("a checkpoint restores to error/recoverable with the exact checkpoint and cancelIntent preserved", async () => {
    const source = fakeFile("photo.jpg", 1000, "image/jpeg");
    const upload = fakeFile("photo.jpg", 400, "image/jpeg");
    const checkpoint: AttachmentCheckpoint = {
      uploadId: "u-restore", paneId: "p1", name: "photo.jpg", size: 400,
      sha256: "a".repeat(64), mime: "image/jpeg", version: 2,
    };
    const record = journalRecord({
      source, upload, checkpoint,
      item: {
        status: "cancelling", acknowledged: 300, cancelIntent: true,
        transferPhase: "commit", scheduled: true,
      },
    });
    expect(restoreAttachmentRecord(record)).toBe(true);
    const id = record.localId;
    expect(runtimeCheckpoint(keyA, id)).toBe(checkpoint); // exact object retained
    expect(runtimeAbort(keyA, id)).toBeNull();
    expect(runtimeGeneration(keyA, id)).toBe(0);
    const item = queueSnapshot(keyA)?.items.find((row) => row.localId === id)!;
    expect(item).toMatchObject({
      status: "error", recoverable: true, cancelIntent: true,
      scheduled: false, transferPhase: undefined, acknowledged: 0, restored: true,
    });
  });

  test("committed and cancelled journal records are ignored", () => {
    const source = fakeFile("done.jpg", 100, "image/jpeg");
    const committed = journalRecord({
      source,
      item: { status: "committed", acknowledged: 100, path: "/tmp/done.jpg" },
    });
    expect(restoreAttachmentRecord(committed)).toBe(false);
    const cancelled = journalRecord({
      source,
      item: { status: "cancelled" },
    });
    expect(restoreAttachmentRecord(cancelled)).toBe(false);
    expect(queueSnapshot(keyA)?.items ?? []).toEqual([]);
  });

  test("an existing row or runtime with the same local id is never overwritten", () => {
    const record = journalRecord({ source: fakeFile("photo.jpg", 1000, "image/jpeg") });
    expect(restoreAttachmentRecord(record)).toBe(true);
    // Second restore of the same journal record collides on runtime AND row.
    expect(restoreAttachmentRecord(record)).toBe(false);
    expect(queueSnapshot(keyA)?.items.filter((row) => row.localId === record.localId)).toHaveLength(1);
  });

  test("identity and upload-metadata mismatches are refused", () => {
    const source = fakeFile("photo.jpg", 1000, "image/jpeg");
    const wrongLocal = journalRecord({ source, localId: "att_x", item: { localId: "att_other" } });
    expect(restoreAttachmentRecord(wrongLocal)).toBe(false);
    const upload = fakeFile("photo.jpg", 400, "image/jpeg");
    const wrongMeta = journalRecord({
      source, upload,
      item: { name: "different.jpg", size: 999, mime: "image/png" },
    });
    expect(restoreAttachmentRecord(wrongMeta)).toBe(false);
    expect(queueSnapshot(keyA)?.items ?? []).toEqual([]);
  });

  test("photo provenance is derived from the source, never from a compressed upload", async () => {
    // JPEG source (a real photo) with a PNG-named upload File.
    const record = journalRecord({
      source: fakeFile("photo.jpg", 1000, "image/jpeg"),
      upload: fakeFile("edited.png", 800, "image/png"),
    });
    expect(restoreAttachmentRecord(record)).toBe(true);
    expect(runtimePhotoOrigin(keyA, record.localId)).toBe(true);
    const screenshot = journalRecord({
      source: fakeFile("Screenshot_1.jpg", 1000, "image/jpeg"),
    });
    expect(restoreAttachmentRecord(screenshot)).toBe(true);
    expect(runtimePhotoOrigin(keyA, screenshot.localId)).toBe(false);
  });

  test("a restored non-image row gets no thumbnail and keeps the exact file", async () => {
    const seen: File[] = [];
    setThumbnailPreparer((file, options) => {
      seen.push(file);
      return abortAwareThumbnail(file, options);
    });
    const doc = new File([new Uint8Array(50)], "doc.pdf", { type: "application/pdf" });
    const record = journalRecord({ source: doc });
    expect(restoreAttachmentRecord(record)).toBe(true);
    const id = record.localId;
    expect(queueSnapshot(keyA)?.items[0]).toMatchObject({ kind: "file", status: "queued", restored: true });
    expect(runtimeSourceFile(keyA, id)).toBe(doc);
    expect(runtimeFile(keyA, id)).toBe(doc);
    await flush();
    expect(seen).toHaveLength(0);
    expect(runtimeObjectUrl(keyA, id)).toBe("");
  });

  test("a restored row never uploads or schedules by itself", async () => {
    const record = journalRecord({
      source: fakeFile("photo.jpg", 1000, "image/jpeg"),
      item: { status: "preparing", compressing: true },
    });
    expect(restoreAttachmentRecord(record)).toBe(true);
    await flush();
    const item = queueSnapshot(keyA)?.items[0]!;
    expect(item.status).toBe("queued");
    expect(item.scheduled ?? false).toBe(false);
    expect(item.compressing).toBe(false);
    expect(runtimeAbort(keyA, record.localId)).toBeNull();
    expect(runtimeGeneration(keyA, record.localId)).toBe(0);
  });
});
