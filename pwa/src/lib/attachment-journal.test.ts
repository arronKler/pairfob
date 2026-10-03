/**
 * Pure tests for the attachment journal codec and the journal's pure
 * quota/TTL policy helpers. No IndexedDB fake framework: the codec is tested
 * by direct encode -> decode on the in-memory object (Blob aliases survive in
 * memory; the separate Blob-alias question after a real IndexedDB
 * structured-clone round-trip is covered by native browser QA, not here —
 * Bun's structuredClone does not preserve same-Blob identity and that is a
 * Bun quirk, not the browser verdict).
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentItem } from "../features/session/attachments/attach-model";
import {
  attachmentRecordBytes,
  decodeAttachmentRecord,
  encodeAttachmentRecord,
  type AttachmentJournalRecord,
} from "./attachment-journal-codec.ts";
import {
  ATTACHMENT_JOURNAL_MAX_BYTES,
  ATTACHMENT_JOURNAL_MAX_FUTURE_MS,
  ATTACHMENT_JOURNAL_MAX_RECORDS,
  ATTACHMENT_JOURNAL_TTL_MS,
  isJournalRecordFresh,
  journalCapacityAfterPut,
  putAttachmentRecord,
} from "./attachment-journal.ts";

const UPLOAD_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const SHA = "a".repeat(64);
const MiB = 1024 * 1024;

function makeFile(name = "data.bin", bytes: number[] = [1, 2, 3], type = "application/octet-stream"): File {
  return new File([new Uint8Array(bytes)], name, { type, lastModified: 1_700_000_000_000 });
}

function makeItem(overrides: Partial<AttachmentItem> = {}): AttachmentItem {
  return {
    localId: "att_1",
    kind: "file",
    name: "data.bin",
    size: 3,
    mime: "application/octet-stream",
    status: "queued",
    acknowledged: 0,
    errorText: "",
    recoverable: false,
    path: "",
    inserted: false,
    editNote: "",
    cancelIntent: false,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<AttachmentJournalRecord> = {}): AttachmentJournalRecord {
  const file = overrides.sourceFile ?? makeFile();
  return {
    version: 1,
    daemonId: "daemon-1",
    paneId: "pane-1",
    localId: "att_1",
    updatedAt: 1_700_000_000_000,
    sourceFile: file,
    uploadFile: file,
    item: makeItem(),
    ...overrides,
  };
}

async function bytesOf(file: File): Promise<number[]> {
  return Array.from(new Uint8Array(await file.arrayBuffer()));
}

function expectThrows(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected action to throw");
}

describe("journal codec file round-trip", () => {
  test("a named-session namespace round-trips through the unchanged v1 tuple format", () => {
    const record = makeRecord({ daemonId: "d_aaaaaaaaaaaaaaaaaaaa:herd:work" });
    const stored = encodeAttachmentRecord(record);
    expect(stored.version).toBe(1);
    expect(stored.key).toEqual([record.daemonId, record.paneId, record.localId]);
    expect(decodeAttachmentRecord(stored)?.daemonId).toBe(record.daemonId);
    expect(encodeAttachmentRecord(makeRecord()).key).toEqual(["daemon-1", "pane-1", "att_1"]);
  });

  test("preserves name, type, lastModified and exact bytes for a same-file row", async () => {
    const file = makeFile("photo draft.bin", [10, 20, 30, 40], "image/png");
    const record = makeRecord({
      sourceFile: file,
      uploadFile: file,
      item: makeItem({ name: "photo draft.bin", size: 4, mime: "image/png", kind: "image" }),
    });
    const stored = encodeAttachmentRecord(record);
    expect(stored.sameFile).toBe(true);
    // One shared blob alias: counted and held once.
    expect(stored.source.blob).toBe(stored.upload.blob);
    expect(attachmentRecordBytes(stored)).toBe(4);

    const back = decodeAttachmentRecord(stored);
    expect(back).not.toBeNull();
    expect(back!.sourceFile).toBe(back!.uploadFile); // one shared File on decode
    for (const file2 of [back!.sourceFile, back!.uploadFile]) {
      expect(file2.name).toBe("photo draft.bin");
      expect(file2.type).toBe("image/png");
      expect(file2.lastModified).toBe(1_700_000_000_000);
      expect(file2.size).toBe(4);
      expect(await bytesOf(file2)).toEqual([10, 20, 30, 40]);
    }
  });

  test("distinct source/upload files round-trip independent exact bytes and count twice", async () => {
    const source = makeFile("big.png", [1, 2, 3, 4, 5], "image/png");
    const upload = makeFile("big.png", [9, 8], "image/png"); // same name/type, different bytes
    const record = makeRecord({
      sourceFile: source,
      uploadFile: upload,
      item: makeItem({ name: "big.png", size: 2, mime: "image/png", kind: "image", originalBytes: 5 }),
    });
    const stored = encodeAttachmentRecord(record);
    expect(stored.sameFile).toBe(false);
    expect(stored.source.blob).not.toBe(stored.upload.blob);
    expect(attachmentRecordBytes(stored)).toBe(7);

    const back = decodeAttachmentRecord(stored);
    expect(back).not.toBeNull();
    expect(back!.sourceFile).not.toBe(back!.uploadFile);
    expect(await bytesOf(back!.sourceFile)).toEqual([1, 2, 3, 4, 5]);
    expect(await bytesOf(back!.uploadFile)).toEqual([9, 8]);
  });

  test("empty files are allowed", () => {
    const file = makeFile("empty", []);
    const stored = encodeAttachmentRecord(makeRecord({
      sourceFile: file,
      uploadFile: file,
      item: makeItem({ name: "empty", size: 0 }),
    }));
    const back = decodeAttachmentRecord(stored);
    expect(back).not.toBeNull();
    expect(back!.uploadFile.size).toBe(0);
    expect(attachmentRecordBytes(stored)).toBe(0);
  });
});

describe("journal codec identity and checkpoint binding", () => {
  function validCheckpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      uploadId: UPLOAD_ID,
      paneId: "pane-1",
      name: "data.bin",
      size: 3,
      sha256: SHA,
      mime: "application/octet-stream",
      ...overrides,
    };
  }

  test("item.localId must match the key localId", () => {
    const error = expectThrows(() => encodeAttachmentRecord(makeRecord({
      item: makeItem({ localId: "att_OTHER" }),
    })));
    expect((error as Error).message).toContain("item.localId");
  });

  test("checkpoint pane must match the record pane", () => {
    const error = expectThrows(() => encodeAttachmentRecord(makeRecord({
      checkpoint: validCheckpoint({ paneId: "pane-OTHER" }) as never,
    })));
    expect((error as Error).message).toContain("checkpoint.paneId");
  });

  test("checkpoint mime must match the normalized upload mime", () => {
    const error = expectThrows(() => encodeAttachmentRecord(makeRecord({
      checkpoint: validCheckpoint({ mime: "image/png" }) as never,
    })));
    expect((error as Error).message).toContain("checkpoint.mime");
  });

  test("checkpoint size must match the upload size", () => {
    const error = expectThrows(() => encodeAttachmentRecord(makeRecord({
      checkpoint: validCheckpoint({ size: 4 }) as never,
    })));
    expect((error as Error).message).toContain("checkpoint.size");
  });

  test("checkpoint name must match the upload name", () => {
    const error = expectThrows(() => encodeAttachmentRecord(makeRecord({
      checkpoint: validCheckpoint({ name: "renamed.bin" }) as never,
    })));
    expect((error as Error).message).toContain("checkpoint.name");
  });

  test("malformed checkpoint digest/version is rejected", () => {
    expect(() => encodeAttachmentRecord(makeRecord({
      checkpoint: validCheckpoint({ sha256: "nope" }) as never,
    }))).toThrow();
    expect(() => encodeAttachmentRecord(makeRecord({
      checkpoint: validCheckpoint({ version: 1 }) as never,
    }))).toThrow();
  });

  test("a valid checkpoint round-trips, including version 2", () => {
    const stored = encodeAttachmentRecord(makeRecord({
      checkpoint: { ...validCheckpoint(), version: 2 } as never,
    }));
    const back = decodeAttachmentRecord(stored);
    expect(back).not.toBeNull();
    expect(back!.checkpoint?.version).toBe(2);
    expect(back!.checkpoint?.uploadId).toBe(UPLOAD_ID);
  });

  test("identity strings must be non-empty, <= 256 and NUL-free", () => {
    expect(() => encodeAttachmentRecord(makeRecord({ daemonId: "" }))).toThrow(/daemonId/);
    expect(() => encodeAttachmentRecord(makeRecord({ paneId: "x".repeat(257) }))).toThrow(/paneId/);
    expect(() => encodeAttachmentRecord(makeRecord({ localId: "bad\u0000id" }))).toThrow(/localId/);
  });
});

describe("journal codec known item fields", () => {
  test("current optional fields are preserved and validated; foreign keys dropped", () => {
    const file = makeFile("p.png", [1, 2], "image/png");
    const item = makeItem({
      name: "p.png",
      size: 2,
      mime: "image/png",
      kind: "image",
      originalBytes: 5,
      imageIntent: "detail",
      scheduled: true,
      transferPhase: "sending",
      stageTimings: { hashing: 12.5, sending: 100, bogus: 1 },
      persistenceWarning: "re-pick after reload",
      restored: true,
      outputWidth: 800,
      outputHeight: 600,
      junk: "drop me",
    } as AttachmentItem);
    const back = decodeAttachmentRecord(encodeAttachmentRecord(makeRecord({
      sourceFile: file,
      uploadFile: file,
      item,
    })));
    expect(back).not.toBeNull();
    // A restored detail intent survives; it is never reset to photo.
    expect(back!.item.imageIntent).toBe("detail");
    expect(back!.item.scheduled).toBe(true);
    expect(back!.item.transferPhase).toBe("sending");
    expect(back!.item.stageTimings).toEqual({ hashing: 12.5, sending: 100 });
    expect(back!.item.persistenceWarning).toBe("re-pick after reload");
    expect(back!.item.restored).toBe(true);
    expect(back!.item.outputWidth).toBe(800);
    expect(back!.item.outputHeight).toBe(600);
    expect("junk" in back!.item).toBe(false);
  });

  test.each([
    ["bad imageIntent", { imageIntent: "photo-ish" }],
    ["bad transferPhase", { transferPhase: "nope" }],
    ["scheduled not boolean", { scheduled: "yes" }],
    ["zero outputWidth", { outputWidth: 0 }],
    ["negative stage timing", { stageTimings: { sending: -1 } }],
    ["bad stage timing value", { stageTimings: { begin: NaN } }],
  ])("rejects %s", (_label, patch) => {
    // The same whitelist sanitizer runs on encode and decode, so a bad value
    // rejects the record at encode time.
    expect(() => encodeAttachmentRecord(makeRecord({
      item: makeItem(patch as Partial<AttachmentItem>),
    }))).toThrow();
  });
});

describe("journal codec malformed stored records", () => {
  test("non-records and wrong versions decode to null", () => {
    for (const garbage of [null, undefined, 42, "x", [], {}, { version: 2 }, { version: 1 }]) {
      expect(decodeAttachmentRecord(garbage)).toBeNull();
    }
  });

  test("tampered key, blobs and metadata decode to null", () => {
    const stored = encodeAttachmentRecord(makeRecord());
    expect(decodeAttachmentRecord({ ...stored, key: ["daemon-1", "pane-1", "att_OTHER"] })).toBeNull();
    expect(decodeAttachmentRecord({ ...stored, updatedAt: -1 })).toBeNull();
    expect(decodeAttachmentRecord({ ...stored, source: { ...stored.source, blob: "not-a-blob" } })).toBeNull();
    expect(decodeAttachmentRecord({ ...stored, item: { ...stored.item, size: 99 } })).toBeNull();
  });

  test("a sameFile flag without a shared blob alias is corrupt, not a source fallback", () => {
    const stored = encodeAttachmentRecord(makeRecord());
    // Same size/name/type metadata, but different bytes: matching metadata
    // must never be accepted as an alias.
    const corrupt = {
      ...stored,
      upload: { ...stored.upload, blob: new Blob([new Uint8Array([9, 9, 9])]) },
    };
    expect(decodeAttachmentRecord(corrupt)).toBeNull();
    // Bytes count both blobs while the alias claim is unverifiable.
    expect(attachmentRecordBytes(corrupt as never)).toBe(6);
  });
});

describe("pure TTL policy (isJournalRecordFresh)", () => {
  const NOW = 1_000_000_000_000;
  test("accepts now, the exact TTL edge and the exact future-skew edge", () => {
    expect(isJournalRecordFresh(NOW, NOW)).toBe(true);
    expect(isJournalRecordFresh(NOW - ATTACHMENT_JOURNAL_TTL_MS, NOW)).toBe(true);
    expect(isJournalRecordFresh(NOW + ATTACHMENT_JOURNAL_MAX_FUTURE_MS, NOW)).toBe(true);
  });
  test("rejects past-TTL and over-skewed timestamps", () => {
    expect(isJournalRecordFresh(NOW - ATTACHMENT_JOURNAL_TTL_MS - 1, NOW)).toBe(false);
    expect(isJournalRecordFresh(NOW + ATTACHMENT_JOURNAL_MAX_FUTURE_MS + 1, NOW)).toBe(false);
  });
});

describe("pure quota policy (journalCapacityAfterPut)", () => {
  test("empty store: one row always counts its own slot and bytes", () => {
    expect(journalCapacityAfterPut(10, 0, 0)).toEqual({ count: 1, bytes: 10, allowed: true });
  });

  test("count cap boundary at 50 records", () => {
    expect(journalCapacityAfterPut(1, 49, 49).allowed).toBe(true); // 50 total
    expect(journalCapacityAfterPut(1, 50, 50).allowed).toBe(false); // 51 total
    expect(journalCapacityAfterPut(1, 50, 50).count).toBe(51);
  });

  test("byte cap boundary at exactly 100 MiB", () => {
    const allowed = journalCapacityAfterPut(MiB, 49, 99 * MiB);
    expect(allowed).toEqual({ count: 50, bytes: 100 * MiB, allowed: true });
    const denied = journalCapacityAfterPut(MiB + 1, 49, 99 * MiB);
    expect(denied.allowed).toBe(false);
    expect(denied.bytes).toBe(100 * MiB + 1);
  });

  test("replacement: incoming bytes ALWAYS count even though the old same-key row is excluded", () => {
    // 50 existing rows at exactly 100 MiB; the replaced row held 20 MiB, so
    // OTHER rows are 49 / 80 MiB. A same-size replacement fits exactly...
    const sameSize = journalCapacityAfterPut(20 * MiB, 49, 80 * MiB);
    expect(sameSize).toEqual({ count: 50, bytes: 100 * MiB, allowed: true });
    // ...but a bigger replacement must NOT bypass the cap by counting zero.
    const bigger = journalCapacityAfterPut(20 * MiB + 1, 49, 80 * MiB);
    expect(bigger.allowed).toBe(false);
    expect(bigger.bytes).toBe(100 * MiB + 1);
    const muchBigger = journalCapacityAfterPut(30 * MiB, 49, 80 * MiB);
    expect(muchBigger.allowed).toBe(false);
  });

  test("exported caps stay the contract constants", () => {
    expect(ATTACHMENT_JOURNAL_MAX_RECORDS).toBe(50);
    expect(ATTACHMENT_JOURNAL_MAX_BYTES).toBe(100 * MiB);
    expect(ATTACHMENT_JOURNAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("put pre-open rejection (no IDB needed: policy runs before open)", () => {
  test("future and expired inputs reject without touching IndexedDB", async () => {
    const file = makeFile();
    const future = makeRecord({ updatedAt: Date.now() + ATTACHMENT_JOURNAL_MAX_FUTURE_MS + 1000 });
    const expired = makeRecord({ updatedAt: Date.now() - ATTACHMENT_JOURNAL_TTL_MS - 1000 });
    await expect(putAttachmentRecord(future)).rejects.toThrow(/future/);
    await expect(putAttachmentRecord(putRecordWithFile(expired, file))).rejects.toThrow(/TTL/);
  });

  test("codec-invalid input rejects before any storage attempt", async () => {
    await expect(putAttachmentRecord(makeRecord({ version: 2 as 1 }))).rejects.toThrow(/version/);
  });
});

function putRecordWithFile(record: AttachmentJournalRecord, file: File): AttachmentJournalRecord {
  return { ...record, sourceFile: file, uploadFile: file };
}
