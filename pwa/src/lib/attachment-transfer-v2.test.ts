// V2 routing integration for attachment-transfer: adapter selection before
// Begin, checkpoint version pinning (no fallback), 128 KiB windowed writes,
// receipt/metadata validation, and version-correct resume/inspect/cancel.
// Self-contained mock session (no mock.module); legacy transfer tests stay
// untouched.
import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  ATTACHMENT_UPLOAD_CHUNK_BYTES_V2,
  type UploadState,
  type UploadWriteInput,
} from "./protocol/attachments.ts";
import { base64Decode, base64Encode } from "./protocol/bytes.ts";
import { ProtocolError } from "./protocol/errors.ts";
import type { LiveSession } from "./protocol/session-types.ts";
import {
  cancelAttachment,
  hashAttachmentFile,
  inspectAttachment,
  resumeAttachment,
  uploadAttachment,
  validateAttachmentCheckpoint,
  type AttachmentCheckpoint,
} from "./attachment-transfer.ts";
import { encodeAttachmentChunk } from "./attachment-codec.ts";

const V2_CHUNK = ATTACHMENT_UPLOAD_CHUNK_BYTES_V2;
const LEGACY_CHUNK = ATTACHMENT_UPLOAD_CHUNK_BYTES;
const UPLOAD_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const SHA = "a".repeat(64);
const PANE = "w1:p1";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeFile(size: number, fill = 0): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i + fill) & 0xff;
  return new File([bytes], "data.bin", { type: "application/octet-stream" });
}

type Call = { op: string; offset?: number; len?: number };

type Recorder = {
  calls: Call[];
  inFlight: number;
  maxActive: number;
  waves: number[];
};

type WriteHook = (input: UploadWriteInput, reply: UploadState) => UploadState;

type MockOptions = {
  /** "v2": cap advertised + all five V2 methods. "legacy": no cap.
   *  "incomplete": cap advertised but one V2 method missing. "lost": cap off. */
  mode: "v2" | "legacy" | "incomplete" | "lost";
  delayMs?: number;
  /** Hold a wave's writes until this many are in flight, so a concurrency
   *  assertion does not depend on how fast the encoder schedules them. */
  barrier?: number;
  statusOffset?: number;
  onBeginV2?: (input: Record<string, unknown>) => UploadState;
  onWriteV2?: WriteHook;
};

function uploading(offset: number, size: number, chunk: number, sha = SHA): UploadState {
  return { upload_id: UPLOAD_ID, state: "uploading", offset, size, sha256: sha, chunk_bytes: chunk };
}

function committed(size: number, chunk: number, sha = SHA): UploadState {
  return {
    ...uploading(size, size, chunk, sha),
    state: "committed",
    path: "/repo/.pairfob/attachments/1b7f/attachment.bin",
    relative_path: ".pairfob/attachments/1b7f/attachment.bin",
    name: "data.bin",
    mime: "application/octet-stream",
  };
}

function cancelled(size: number, chunk: number, sha = SHA): UploadState {
  return { ...uploading(0, size, chunk, sha), state: "cancelled" };
}

/** Mock daemon with independent legacy and V2 RPC families and a call log. */
function mockSession(options: MockOptions, initialSize = 0, initialSha = SHA): { session: LiveSession; rec: Recorder } {
  const rec: Recorder = { calls: [], inFlight: 0, maxActive: 0, waves: [] };
  const active = { uploadId: UPLOAD_ID, size: initialSize, sha: initialSha };
  const mode = options.mode;
  let barrierWaiters = 0;
  let barrierOpen = options.barrier === undefined;
  let openBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    openBarrier = resolve;
  });

  const recordWrite = async (input: UploadWriteInput, family: "v2" | "legacy"): Promise<UploadState> => {
    const chunk = family === "v2" ? V2_CHUNK : LEGACY_CHUNK;
    rec.calls.push({ op: family === "v2" ? "writeV2" : "write", offset: input.offset, len: base64Decode(input.data_b64).length });
    if (options.delayMs !== undefined) {
      if (rec.inFlight === 0) rec.waves.push(0);
      rec.inFlight += 1;
      rec.maxActive = Math.max(rec.maxActive, rec.inFlight);
      if (!barrierOpen) {
        barrierWaiters += 1;
        if (barrierWaiters < options.barrier!) await barrier;
        else {
          barrierOpen = true;
          openBarrier?.();
        }
      }
      await delay(options.delayMs);
      rec.inFlight -= 1;
      rec.waves[rec.waves.length - 1] += 1;
    }
    const reply: UploadState = {
      ...uploading(input.offset + base64Decode(input.data_b64).length, active.size, chunk, active.sha),
      upload_id: active.uploadId,
    };
    if (family === "v2" && options.onWriteV2) return options.onWriteV2(input, reply);
    return reply;
  };

  const legacy = {
    workspaceUploadBegin: async (input: Record<string, unknown>) => {
      rec.calls.push({ op: "begin" });
      active.uploadId = input.upload_id as string;
      active.size = input.size as number;
      active.sha = input.sha256 as string;
      return { ...uploading(0, active.size, LEGACY_CHUNK, active.sha), upload_id: active.uploadId };
    },
    workspaceUploadWrite: (input: UploadWriteInput) => recordWrite(input, "legacy"),
    workspaceUploadStatus: async () => {
      rec.calls.push({ op: "status" });
      return { ...uploading(options.statusOffset ?? 0, active.size, LEGACY_CHUNK, active.sha), upload_id: active.uploadId };
    },
    workspaceUploadCommit: async () => {
      rec.calls.push({ op: "commit" });
      return { ...committed(active.size, LEGACY_CHUNK, active.sha), upload_id: active.uploadId };
    },
    workspaceUploadCancel: async () => {
      rec.calls.push({ op: "cancel" });
      return { ...cancelled(active.size, LEGACY_CHUNK, active.sha), upload_id: active.uploadId };
    },
  };

  const v2 = {
    workspaceUploadBeginV2: async (input: Record<string, unknown>) => {
      rec.calls.push({ op: "beginV2" });
      active.uploadId = input.upload_id as string;
      active.size = input.size as number;
      active.sha = input.sha256 as string;
      const state: UploadState = { ...uploading(0, active.size, V2_CHUNK, active.sha), upload_id: active.uploadId };
      return options.onBeginV2 ? options.onBeginV2(input) : state;
    },
    workspaceUploadWriteV2: (input: UploadWriteInput) => recordWrite(input, "v2"),
    workspaceUploadStatusV2: async () => {
      rec.calls.push({ op: "statusV2" });
      return { ...uploading(options.statusOffset ?? 0, active.size, V2_CHUNK, active.sha), upload_id: active.uploadId };
    },
    workspaceUploadCommitV2: async () => {
      rec.calls.push({ op: "commitV2" });
      return { ...committed(active.size, V2_CHUNK, active.sha), upload_id: active.uploadId };
    },
    workspaceUploadCancelV2: async () => {
      rec.calls.push({ op: "cancelV2" });
      return { ...cancelled(active.size, V2_CHUNK, active.sha), upload_id: active.uploadId };
    },
  };

  const session: Record<string, unknown> = { ...legacy };
  if (mode === "v2" || mode === "incomplete") session.supportsUploadV2 = () => true;
  if (mode === "lost") session.supportsUploadV2 = () => false;
  if (mode === "v2" || mode === "lost") Object.assign(session, v2);
  if (mode === "incomplete") {
    // All five must be present as functions; drop one to prove fail-closed
    // selection falls back to legacy BEFORE any RPC.
    const { workspaceUploadCancelV2: _omit, ...partial } = v2;
    void _omit;
    Object.assign(session, partial);
  }
  return { session: session as unknown as LiveSession, rec };
}

async function checkpointFor(file: File, version?: 2): Promise<AttachmentCheckpoint> {
  const checkpoint: AttachmentCheckpoint = {
    uploadId: UPLOAD_ID,
    paneId: PANE,
    name: file.name,
    size: file.size,
    sha256: await hashAttachmentFile(file),
    mime: "application/octet-stream",
  };
  if (version === 2) checkpoint.version = 2;
  return checkpoint;
}

async function rejectError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("V2 selection before Begin", () => {
  test("cap plus all five methods routes Begin/write/commit to V2 and pins checkpoint version 2", async () => {
    const file = makeFile(V2_CHUNK * 2 + 10);
    const { session, rec } = mockSession({ mode: "v2" });
    let seen: AttachmentCheckpoint | undefined;
    const state = await uploadAttachment(session, PANE, file, { onCheckpoint: (cp) => { seen = cp; } });

    expect(state.state).toBe("committed");
    expect(seen?.version).toBe(2);
    expect(rec.calls.map((c) => c.op)).toEqual(["beginV2", "writeV2", "writeV2", "writeV2", "commitV2"]);
    // Window writes are offset-tagged; worker encode completion (and thus RPC
    // arrival) order is not guaranteed, so compare after ordering by offset.
    const writes = rec.calls.filter((c) => c.op === "writeV2").sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
    expect(writes.map((c) => c.offset)).toEqual([0, V2_CHUNK, V2_CHUNK * 2]);
    expect(writes.map((c) => c.len)).toEqual([V2_CHUNK, V2_CHUNK, 10]);
  });

  test("missing capability uses legacy and leaves checkpoint.version absent", async () => {
    const file = makeFile(LEGACY_CHUNK + 5);
    const { session, rec } = mockSession({ mode: "legacy" });
    let seen: AttachmentCheckpoint | undefined;
    const state = await uploadAttachment(session, PANE, file, { onCheckpoint: (cp) => { seen = cp; } });
    expect(state.state).toBe("committed");
    expect(seen?.version).toBeUndefined();
    expect(rec.calls.map((c) => c.op)).toEqual(["begin", "write", "write", "commit"]);
  });

  test("advertised cap with an incomplete V2 method set selects legacy before any V2 RPC", async () => {
    const file = makeFile(16);
    const { session, rec } = mockSession({ mode: "incomplete" });
    const state = await uploadAttachment(session, PANE, file);
    expect(state.state).toBe("committed");
    expect(rec.calls.map((c) => c.op)).toEqual(["begin", "write", "commit"]);
    expect(rec.calls.some((c) => c.op.endsWith("V2"))).toBe(false);
  });

  test("zero-byte V2 file Begins and Commits without any write", async () => {
    const file = makeFile(0);
    const { session, rec } = mockSession({ mode: "v2" });
    const state = await uploadAttachment(session, PANE, file);
    expect(state.state).toBe("committed");
    expect(rec.calls.map((c) => c.op)).toEqual(["beginV2", "commitV2"]);
  });
});

describe("V2 errors never fall back", () => {
  test("Begin unknown_op surfaces once; no legacy RPC and no commit", async () => {
    const file = makeFile(8);
    const { session, rec } = mockSession({
      mode: "v2",
      onBeginV2: () => {
        throw new ProtocolError("unknown_op", "连接在确认结果前中断");
      },
    });
    const error = await rejectError(uploadAttachment(session, PANE, file));
    expect((error as ProtocolError).code).toBe("unknown_op");
    expect(rec.calls.map((c) => c.op)).toEqual(["beginV2"]);
  });

  test("Write unknown_op stops after the first 4-deep window; legacy methods stay untouched", async () => {
    const file = makeFile(V2_CHUNK * 8);
    const { session, rec } = mockSession({
      mode: "v2",
      onWriteV2: () => {
        throw new ProtocolError("unknown_op", "连接在确认结果前中断");
      },
    });
    const error = await rejectError(uploadAttachment(session, PANE, file));
    expect((error as ProtocolError).code).toBe("unknown_op");
    // One window of four is launched synchronously; a second wave never is.
    expect(rec.calls.filter((c) => c.op === "writeV2")).toHaveLength(4);
    expect(rec.calls.some((c) => c.op === "commitV2")).toBe(false);
    expect(rec.calls.some((c) => !c.op.endsWith("V2"))).toBe(false);
  });

  test("write receipt whose offset is not the requested end is conflict; no second wave or commit", async () => {
    const file = makeFile(V2_CHUNK * 8);
    const { session, rec } = mockSession({
      mode: "v2",
      onWriteV2: (input, reply) => ({ ...reply, offset: input.offset }),
    });
    const error = await rejectError(uploadAttachment(session, PANE, file));
    expect((error as ProtocolError).code).toBe("conflict");
    expect(rec.calls.filter((c) => c.op === "writeV2")).toHaveLength(4);
    expect(rec.calls.some((c) => c.op === "commitV2")).toBe(false);
  });

  test("write receipt with legacy chunk_bytes is immutable-metadata conflict", async () => {
    const file = makeFile(V2_CHUNK * 8);
    const { session, rec } = mockSession({
      mode: "v2",
      onWriteV2: (_input, reply) => ({ ...reply, chunk_bytes: LEGACY_CHUNK }),
    });
    const error = await rejectError(uploadAttachment(session, PANE, file));
    expect((error as ProtocolError).code).toBe("conflict");
    expect(rec.calls.filter((c) => c.op === "writeV2")).toHaveLength(4);
    expect(rec.calls.some((c) => c.op === "commitV2")).toBe(false);
  });
});

describe("version-2 resume / inspect / cancel", () => {
  test("resume reads V2 status first, continues at the server offset, never Begins", async () => {
    const file = makeFile(V2_CHUNK * 2);
    const checkpoint = await checkpointFor(file, 2);
    const { session, rec } = mockSession({ mode: "v2", statusOffset: V2_CHUNK }, file.size, checkpoint.sha256);
    const state = await resumeAttachment(session, checkpoint, file);
    expect(state.state).toBe("committed");
    expect(rec.calls.map((c) => c.op)).toEqual(["statusV2", "writeV2", "commitV2"]);
    expect(rec.calls.find((c) => c.op === "writeV2")?.offset).toBe(V2_CHUNK);
  });

  test("inspect uses V2 status and nothing else; cancel uses V2 cancel once", async () => {
    const file = makeFile(16);
    const checkpoint = await checkpointFor(file, 2);
    const inspect = mockSession({ mode: "v2", statusOffset: 8 }, file.size, checkpoint.sha256);
    const status = await inspectAttachment(inspect.session, checkpoint);
    expect(status.offset).toBe(8);
    expect(inspect.rec.calls.map((c) => c.op)).toEqual(["statusV2"]);

    const cancel = mockSession({ mode: "v2" }, file.size, checkpoint.sha256);
    const result = await cancelAttachment(cancel.session, checkpoint);
    expect(result.state).toBe("cancelled");
    expect(cancel.rec.calls.map((c) => c.op)).toEqual(["cancelV2"]);
  });

  test.each(["lost", "incomplete"] as const)("cap %p on a v2 checkpoint errors forbidden with zero RPCs", async (mode) => {
    const file = makeFile(16);
    const checkpoint = await checkpointFor(file, 2);
    const attempts: Array<{ rec: Recorder; run: () => Promise<unknown> }> = [
      (() => {
        const built = mockSession({ mode });
        return { rec: built.rec, run: () => resumeAttachment(built.session, checkpoint, file) };
      })(),
      (() => {
        const built = mockSession({ mode });
        return { rec: built.rec, run: () => inspectAttachment(built.session, checkpoint) };
      })(),
      (() => {
        const built = mockSession({ mode });
        return { rec: built.rec, run: () => cancelAttachment(built.session, checkpoint) };
      })(),
    ];
    for (const attempt of attempts) {
      const error = await rejectError(attempt.run());
      expect((error as ProtocolError).code).toBe("forbidden");
      expect(attempt.rec.calls).toEqual([]);
    }
  });
});

describe("checkpoint version validation", () => {
  test("absent version (legacy) and 2 are valid; other explicit values reject", async () => {
    const file = makeFile(8);
    const base = await checkpointFor(file);
    expect(() => validateAttachmentCheckpoint(base)).not.toThrow();
    expect(() => validateAttachmentCheckpoint({ ...base, version: 2 })).not.toThrow();
    for (const bad of [0, 1, 3] as const) {
      const error = await rejectError(Promise.resolve().then(() =>
        validateAttachmentCheckpoint({ ...base, version: bad as unknown as 2 })));
      expect((error as ProtocolError).code).toBe("invalid_argument");
    }
  });

  test("resume with an explicit invalid version rejects before any RPC", async () => {
    const file = makeFile(8);
    const checkpoint = { ...(await checkpointFor(file)), version: 1 as 2 };
    const { session, rec } = mockSession({ mode: "v2" });
    const error = await rejectError(resumeAttachment(session, checkpoint, file));
    expect((error as ProtocolError).code).toBe("invalid_argument");
    expect(rec.calls).toEqual([]);
  });
});

describe("V2 abort and windowing", () => {
  test("abort during the first window sends no second wave and never commits", async () => {
    const file = makeFile(V2_CHUNK * 8);
    const controller = new AbortController();
    const { session, rec } = mockSession({
      mode: "v2",
      onWriteV2: (input, reply) => {
        if (input.offset === 0) controller.abort();
        return reply;
      },
    });
    const error = await rejectError(uploadAttachment(session, PANE, file, { signal: controller.signal }));
    expect((error as DOMException).name).toBe("AbortError");
    const writes = rec.calls.filter((c) => c.op === "writeV2");
    // Only the first four-deep window may launch; encode workers complete out
    // of order, so assert the SET of offsets is a subset of wave one (and
    // includes the aborting offset) rather than arrival order.
    expect(writes.length).toBeLessThanOrEqual(4);
    expect(writes.map((c) => c.offset)).toContain(0);
    const firstWave = new Set([0, V2_CHUNK, V2_CHUNK * 2, V2_CHUNK * 3]);
    expect(writes.every((c) => firstWave.has(c.offset ?? -1))).toBe(true);
    expect(rec.calls.some((c) => c.op === "commitV2")).toBe(false);
  });

  test.each([50, 100])("%ims delayed writes: V2 holds four simultaneous in one round, legacy is 16 serial rounds", async (delayMs) => {
    const size = V2_CHUNK * 4; // 512 KiB = 4 V2 chunks = 16 legacy chunks
    const v2 = mockSession({ mode: "v2", delayMs, barrier: 4 });
    await uploadAttachment(v2.session, PANE, makeFile(size));
    expect(v2.rec.maxActive).toBe(4);
    expect(v2.rec.waves).toEqual([4]);

    const legacy = mockSession({ mode: "legacy", delayMs });
    await uploadAttachment(legacy.session, PANE, makeFile(size));
    expect(legacy.rec.maxActive).toBe(1);
    expect(legacy.rec.waves).toHaveLength(16);
    expect(legacy.rec.waves.every((n) => n === 1)).toBe(true);
    // Structural concurrency proof only (round counts/depth at a fixed delay);
    // no elapsed-clock throughput claim is made.
  }, 15000);
});

describe("real codec hash/base64 parity", () => {
  test("hashAttachmentFile matches known SHA-256 vectors through the off-thread codec", async () => {
    expect(await hashAttachmentFile(makeFile(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const abc = new File([new TextEncoder().encode("abc")], "abc.txt", { type: "text/plain" });
    expect(await hashAttachmentFile(abc)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("encodeAttachmentChunk is canonical base64 at both chunk sizes, partial and empty", async () => {
    const file = makeFile(V2_CHUNK + 37, 0x21);
    const cases: Array<[number, number]> = [
      [0, LEGACY_CHUNK],
      [0, V2_CHUNK],
      [V2_CHUNK, V2_CHUNK + 37],
      [V2_CHUNK + 10, V2_CHUNK + 10],
    ];
    for (const [offset, end] of cases) {
      const encoded = await encodeAttachmentChunk(file, offset, end);
      const expectedBytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      expect(encoded).toBe(base64Encode(expectedBytes));
      expect(base64Decode(encoded)).toEqual(expectedBytes);
    }
    expect(await encodeAttachmentChunk(file, 0, 0)).toBe("");
  });

  test("every wire write payload decodes to the file slice at its offset (V2 and legacy)", async () => {
    for (const mode of ["v2", "legacy"] as const) {
      const chunk = mode === "v2" ? V2_CHUNK : LEGACY_CHUNK;
      const size = chunk * 2 + 7;
      const file = makeFile(size, 0x33);
      const expected = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
      const seen: Array<{ offset: number; bytes: Uint8Array }> = [];
      const built = mockSession({ mode });
      // Wrap the raw mock to inspect data_b64 at the session boundary.
      const rawSession = built.session as unknown as Record<string, (input: UploadWriteInput) => Promise<UploadState>>;
      const writeKey = mode === "v2" ? "workspaceUploadWriteV2" : "workspaceUploadWrite";
      const original = rawSession[writeKey].bind(rawSession);
      rawSession[writeKey] = async (input: UploadWriteInput) => {
        seen.push({ offset: input.offset, bytes: base64Decode(input.data_b64) });
        return original(input);
      };
      const state = await uploadAttachment(built.session, PANE, file);
      expect(state.state).toBe("committed");
      const ordered = seen.sort((a, b) => a.offset - b.offset);
      expect(ordered).toHaveLength(3);
      expect(ordered.map((p) => p.bytes.length)).toEqual([chunk, chunk, 7]);
      for (const piece of ordered) {
        expect(piece.bytes).toEqual(expected.subarray(piece.offset, piece.offset + piece.bytes.length));
      }
    }
  });
});
