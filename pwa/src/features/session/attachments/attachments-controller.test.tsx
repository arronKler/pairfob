import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import { setLang } from "../../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import { ProtocolError } from "../../../lib/protocol/errors";
import type { LiveSession, PairResult } from "../../../lib/protocol/client";
import { setPhase, setSessionTransport } from "../../connection/connection-store";
import { applyCapabilities } from "../../operations/capabilities-store";
import { attachLiveSession, currentDaemonId, setCredential } from "../../computers/catalog-store";
import { selectPane, setFullTerminal } from "../session-store";
import { setComposeDraft } from "../compose-store";
import { resetComposeDrafts } from "../drafts/compose-drafts";
import { SessionCompose } from "../guided/session-compose";
import {
  addPickedFiles,
  cancelUpload,
  checkUpload,
  removeItem,
  resumeUpload,
  setAttachmentTransferPort,
  settleTransferQueue,
  startAllQueued,
  startUpload,
} from "./attachments-controller";
import {
  resetAttachmentQueues,
  attachmentScopeKey,
  queueSnapshot,
  runtimeCheckpoint,
} from "./attachments-store";
import type {
  AttachmentCheckpoint,
  AttachmentTransferOptions,
  AttachmentTransferPort,
  UploadStateLike,
} from "./attach-model";

const SCOPE = { daemonId: "d1", paneId: "p1" } as const;
const KEY = attachmentScopeKey(SCOPE);
const COMMITTED_PATH = "/tmp/demo/.pairfob/attachments/abcd1234/notes.txt";

function file(name: string, size: number, type = ""): File {
  return new File([new Uint8Array(size)], name, { type });
}

function committedState(size: number, uploadId = "u1"): UploadStateLike {
  return {
    upload_id: uploadId, state: "committed", offset: size, size,
    sha256: "a".repeat(64), chunk_bytes: 32768, path: COMMITTED_PATH,
  };
}

type Behavior =
  | "commit"
  | "defer"
  | "deferCheckpoint"
  | "unknown"
  | "workspaceNotFound"
  | "internal"
  | "forbidden"
  | "conflict"
  | "cancelCommitted"
  | "cancelReject"
  | "expiredCancel"
  | "resumeProgress";

type FakePort = AttachmentTransferPort & {
  calls: Array<{ method: string; name?: string }>;
  active: number;
  maxActive: number;
  resolveAll: () => void;
  resolveOne: () => void;
  rejectActive: (error: unknown) => void;
  setBehavior: (behavior: Behavior) => void;
  deferred: () => boolean;
  lastSignal: AbortSignal | null;
  progress: () => ((acknowledged: number, total: number) => void) | null;
};

function makePort(initial: Behavior = "commit"): FakePort {
  let behavior: Behavior = initial;
  const calls: FakePort["calls"] = [];
  let active = 0;
  let maxActive = 0;
  let lastSignal: AbortSignal | null = null;
  type Pending = { resolve: (state: UploadStateLike) => void; reject: (error: unknown) => void; signal: AbortSignal; size: number };
  let pending: Pending[] = [];
  let lastProgress: ((acknowledged: number, total: number) => void) | null = null;
  const abortError = () => new DOMException("aborted", "AbortError");
  const port: AttachmentTransferPort = {
    limits: { maxFileBytes: 20 * 1024 * 1024, maxBatchBytes: 40 * 1024 * 1024, maxFiles: 5 },
    async upload(_session, paneId, picked, options?: AttachmentTransferOptions) {
      calls.push({ method: "upload", name: picked.name });
      active += 1;
      maxActive = Math.max(maxActive, active);
      lastSignal = options?.signal ?? null;
      lastProgress = options?.onProgress ?? null;
      // deferCheckpoint simulates the hashing phase BEFORE the Begin checkpoint
      // is emitted: no checkpoint exists and no RPC has started yet.
      if (behavior !== "deferCheckpoint") {
        await options?.onCheckpoint?.({
          uploadId: `u_${picked.name}`, paneId, name: picked.name,
          size: picked.size, sha256: "a".repeat(64), mime: picked.type || "application/octet-stream",
        });
      }
      try {
        if (behavior === "defer" || behavior === "deferCheckpoint") {
          return await new Promise<UploadStateLike>((resolve, reject) => {
            const entry: Pending = {
              resolve, reject, signal: options!.signal!, size: picked.size,
            };
            pending.push(entry);
            options!.signal!.addEventListener("abort", () => reject(abortError()), { once: true });
          });
        }
        if (behavior === "unknown") throw new ProtocolError("unknown_outcome", "uncertain");
        if (behavior === "workspaceNotFound") throw new ProtocolError("workspace_not_found", "gone");
        if (behavior === "internal") throw new ProtocolError("internal", "boom");
        if (behavior === "forbidden") throw new ProtocolError("forbidden", "no");
        if (behavior === "conflict") throw new ProtocolError("conflict", "mismatch");
        options?.onProgress?.(picked.size, picked.size);
        return committedState(picked.size, `u_${picked.name}`);
      } finally {
        active -= 1;
      }
    },
    async resume(_session, checkpoint, _file, options?: AttachmentTransferOptions) {
      calls.push({ method: "resume", name: checkpoint.name });
      if (options?.onProgress) lastProgress = options.onProgress;
      if (behavior === "unknown") throw new ProtocolError("unknown_outcome", "uncertain");
      if (behavior === "defer") {
        return await new Promise<UploadStateLike>((resolve, reject) => {
          pending.push({ resolve, reject, signal: options!.signal!, size: checkpoint.size });
        });
      }
      // Mirrors B's real resume: status first, then acknowledged progress with
      // NO onCheckpoint before the final committed state.
      if (behavior === "resumeProgress") {
        return await new Promise<UploadStateLike>((resolve, reject) => {
          options?.onProgress?.(Math.floor(checkpoint.size / 2), checkpoint.size);
          pending.push({ resolve, reject, signal: options!.signal!, size: checkpoint.size });
        });
      }
      return committedState(checkpoint.size, checkpoint.uploadId);
    },
    async inspect(_session, checkpoint) {
      calls.push({ method: "inspect", name: checkpoint.name });
      if (behavior === "expiredCancel") throw new ProtocolError("workspace_not_found", "lost");
      if (behavior === "defer") {
        return {
          upload_id: checkpoint.uploadId, state: "uploading", offset: 0,
          size: checkpoint.size, sha256: "a".repeat(64), chunk_bytes: 32768,
        };
      }
      if (behavior === "cancelReject") throw new ProtocolError("unknown_outcome", "cancel uncertain");
      return committedState(checkpoint.size, checkpoint.uploadId);
    },
    async cancel(_session, checkpoint) {
      calls.push({ method: "cancel", name: checkpoint.name });
      if (behavior === "expiredCancel") throw new ProtocolError("workspace_not_found", "lost");
      if (behavior === "cancelCommitted") return committedState(checkpoint.size, checkpoint.uploadId);
      if (behavior === "cancelReject") throw new ProtocolError("unknown_outcome", "cancel lost");
      return {
        upload_id: checkpoint.uploadId, state: "cancelled", offset: 0,
        size: checkpoint.size, sha256: "a".repeat(64), chunk_bytes: 32768,
      };
    },
  };
  return {
    ...port,
    calls,
    get active() { return active; },
    get maxActive() { return maxActive; },
    get lastSignal() { return lastSignal; },
    deferred: () => pending.length > 0,
    resolveOne: () => { const entry = pending.shift(); entry?.resolve(committedState(entry.size)); },
    resolveAll: () => { const rest = pending; pending = []; for (const entry of rest) entry.resolve(committedState(entry.size)); },
    rejectActive: (error) => { const rest = pending; pending = []; for (const entry of rest) entry.reject(error); },
    setBehavior: (next) => { behavior = next; },
    progress: () => lastProgress,
  };
}

let port: FakePort;
const sendingCalls: string[] = [];
const session = {
  isConnected: () => true,
  sendText: async (...args: unknown[]) => { sendingCalls.push(`sendText:${String((args[0] as string)?.slice(0, 40))}`); },
  sendKeys: async (...args: unknown[]) => { sendingCalls.push(`sendKeys:${JSON.stringify(args[0])}`); },
  promptAgent: async (...args: unknown[]) => { sendingCalls.push(`promptAgent:${String(args[0])}`); },
} as unknown as LiveSession;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("en");
  setPhase("live"); setSessionTransport("p2p");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(false);
  setCredential({ daemonId: "d1" } as unknown as PairResult);
  attachLiveSession(session);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, upload_file: true } as never, []);
  resetComposeDrafts();
  resetAttachmentQueues();
  setComposeDraft("");
  sendingCalls.length = 0;
  port = makePort();
  setAttachmentTransferPort(port);
});

afterEach(async () => {
  unmountReact();
  // Never let a still-deferred fake transfer strand the shared scheduler:
  // abort it so the row settles (the controller treats AbortError as a cancel
  // outcome), then drain before the next test.
  if (port.deferred()) port.rejectActive(new DOMException("aborted", "AbortError"));
  setAttachmentTransferPort(null);
  attachLiveSession(null);
  setCredential(null);
  setFullTerminal(false);
  resetAttachmentQueues();
  resetComposeDrafts();
  await settleTransferQueue();
  appRoot().replaceChildren();
});

async function settle(): Promise<void> {
  await act(async () => { await settleTransferQueue(); });
}

function paintGuided(): HTMLTextAreaElement {
  renderReact(<SessionCompose includeBack={true} />);
  return appRoot().querySelector<HTMLTextAreaElement>(".dock-form textarea")!;
}

/** Start an upload and let the serial scheduler actually reach the transfer port. */
async function startJob(id: string): Promise<void> {
  act(() => startUpload(SCOPE, id));
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function uploadOne(name: string, size: number): Promise<string> {
  await act(async () => {
    await addPickedFiles(SCOPE, [file(name, size)]);
  });
  const id = queueSnapshot(KEY)!.items[0].localId;
  act(() => startUpload(SCOPE, id));
  await settle();
  return id;
}

describe("generation, scheduler and cancel semantics", () => {
  test("double synchronous start claims one operation and issues one upload", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("dup.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    act(() => {
      startUpload(SCOPE, id);
      startUpload(SCOPE, id); // second click before any microtask settles
    });
    await settle();
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(1);
    expect(queueSnapshot(KEY)?.items[0].status).toBe("committed");
  });

  test("the client runs at most one transfer at a time, including individual clicks", async () => {
    await act(async () => {
      await addPickedFiles(SCOPE, [file("a", 1), file("b", 1), file("c", 1)]);
    });
    port.setBehavior("defer");
    act(() => {
      for (const item of queueSnapshot(KEY)!.items) startUpload(SCOPE, item.localId);
    });
    // Only the first starts; the other two are queued, not issued.
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(port.deferred()).toBe(true);
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(1);
    port.resolveOne();
    // Let the chain settle job A and start job B (a few microtask ticks:
    // job continuation, scheduler link, port lookup, then upload).
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(2);
    expect(port.maxActive).toBe(1);
    // The third file starts only AFTER B settles. Switch to commit so the
    // later-starting job settles instead of remaining deferred forever.
    port.setBehavior("commit");
    port.resolveAll();
    await settle();
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(3);
    expect(port.maxActive).toBe(1);
    expect(port.active).toBe(0);
    expect(queueSnapshot(KEY)?.items.every((item) => item.status === "committed")).toBe(true);
  });

  test("cancel aborts the attempt and sends exactly one cancel after settlement", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("c.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    expect(port.deferred()).toBe(true);
    act(() => {
      cancelUpload(SCOPE, id);
      cancelUpload(SCOPE, id); // duplicate cancel is a no-op
    });
    expect(queueSnapshot(KEY)?.items[0].status).toBe("cancelling");
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("cancelled");
    expect(runtimeCheckpoint(KEY, id)).toBeNull();
    expect(port.calls.map((call) => call.method)).toEqual(["upload", "cancel"]);
  });

  test("a cancel whose commit wins the race reconciles the row as committed", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("win.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    act(() => cancelUpload(SCOPE, id));
    port.setBehavior("cancelCommitted");
    await settle();
    expect(queueSnapshot(KEY)?.items[0]).toMatchObject({ status: "committed", path: COMMITTED_PATH });
    expect(port.calls.map((call) => call.method)).toEqual(["upload", "cancel"]);
  });

  test("cancel before begin needs no RPC: no checkpoint yet means local cancel is exact", async () => {
    // A port whose begin (checkpoint) never arrives is simulated by a queued
    // job whose owner moved away before start: cancel still claims, then the
    // skipped attempt leaves no checkpoint.
    await act(async () => { await addPickedFiles(SCOPE, [file("early.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    // Start is claimed but queued; cancel claims before the job runs.
    act(() => {
      startUpload(SCOPE, id);
      cancelUpload(SCOPE, id);
    });
    await settle();
    // The job sees the newer generation and does not run; cancel job finds the
    // checkpoint only if begin was emitted. With no execution, it is absent.
    expect(queueSnapshot(KEY)?.items[0].status).toBe("cancelled");
    expect(port.calls.some((call) => call.method === "cancel")).toBe(false);
  });

  test("cancel with no live connection retains checkpoint and intent, never false cancelled", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("off.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    expect(port.deferred()).toBe(true);
    attachLiveSession(null);
    setPhase("connect");
    act(() => cancelUpload(SCOPE, id));
    await settle();
    const item = queueSnapshot(KEY)?.items[0]!;
    expect(item.status).toBe("error");
    expect(item.cancelIntent).toBe(true);
    expect(item.errorText).toContain("Reconnect");
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();
    // No cancel RPC can target the wrong session.
    expect(port.calls.some((call) => call.method === "cancel")).toBe(false);
  });

  test("after reconnect, an explicit status check settles a retained cancel (read-only)", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("back.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    attachLiveSession(null);
    setPhase("connect");
    act(() => cancelUpload(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("error");

    attachLiveSession(session);
    setPhase("live"); setSessionTransport("p2p");
    port.setBehavior("commit");
    await act(async () => checkUpload(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("committed");
    // Reconciliation read one status; it never resumed, wrote, or re-began.
    expect(port.calls.map((call) => call.method)).toEqual(["upload", "inspect"]);
  });

  test("unknown cancel stays unresolved: only check/retry-cancel, never resume or begin", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("u.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    port.setBehavior("cancelReject"); // cancel throws, inspect throws too
    act(() => cancelUpload(SCOPE, id));
    await settle();
    const item1 = queueSnapshot(KEY)?.items[0]!;
    expect(item1.status).toBe("error");
    expect(item1.cancelIntent).toBe(true);
    expect(item1.recoverable).toBe(false);
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();

    // Explicit resume is refused for a cancel-intent row.
    act(() => resumeUpload(SCOPE, id));
    await settle();
    expect(port.calls.some((call) => call.method === "resume")).toBe(false);
    act(() => startUpload(SCOPE, id));
    await settle();
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(1);

    // Retrying the cancel issues one more explicit cancel attempt.
    act(() => cancelUpload(SCOPE, id));
    await settle();
    expect(port.calls.filter((call) => call.method === "cancel")).toHaveLength(2);
  });

  test("uncertain upload outcomes require an explicit resume that reads status instead of re-beginning", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("u.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("unknown");
    act(() => startUpload(SCOPE, id));
    await settle();
    const item = queueSnapshot(KEY)!.items[0]!;
    expect(item.status).toBe("error");
    expect(item.recoverable).toBe(true);

    port.setBehavior("commit");
    act(() => resumeUpload(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("committed");
    expect(port.calls.map((call) => call.method)).toEqual(["upload", "resume"]);
  });

  test("resume progress promotes preparing to uploading and tracks acknowledged offsets", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("r.txt", 8)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("unknown");
    act(() => startUpload(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items[0]).toMatchObject({ status: "error", recoverable: true });

    // B's resume emits no checkpoint: the first acknowledged progress must
    // promote preparing to uploading and publish the server offset.
    port.setBehavior("resumeProgress");
    act(() => resumeUpload(SCOPE, id));
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    expect(queueSnapshot(KEY)?.items[0]).toMatchObject({ status: "uploading", acknowledged: 4 });

    act(() => { port.progress()?.(6, 8); });
    // Intermediate samples are throttled (~150ms): the burst coalesces and
    // the trailing edge publishes the newest offset, not every callback.
    expect(queueSnapshot(KEY)?.items[0]?.acknowledged).toBe(4);
    act(() => { port.progress()?.(99, 8); });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 200)); });
    // The trailing update is bounded by size and stays monotonic.
    expect(queueSnapshot(KEY)?.items[0]?.acknowledged).toBe(8);

    port.resolveAll();
    await settle();
    expect(queueSnapshot(KEY)?.items[0]).toMatchObject({ status: "committed", acknowledged: 8 });
    // Stale progress after the terminal state never demotes or overwrites.
    act(() => { port.progress()?.(0, 8); });
    expect(queueSnapshot(KEY)?.items[0]).toMatchObject({ status: "committed", acknowledged: 8 });
  });

  test("a cancelled-away generation's progress never promotes or moves the row", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("c.txt", 8)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("unknown");
    act(() => startUpload(SCOPE, id));
    await settle();
    const staleProgress = port.progress(); // captured from the superseded generation
    expect(staleProgress).not.toBeNull();
    port.setBehavior("defer");
    act(() => resumeUpload(SCOPE, id));
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    // Cancel claims the row (bumps the generation) while the resume is in flight.
    act(() => cancelUpload(SCOPE, id));
    act(() => { staleProgress?.(8, 8); }); // stale generation: must be ignored
    expect(queueSnapshot(KEY)?.items[0]?.status).toBe("cancelling");
    expect(queueSnapshot(KEY)?.items[0]?.acknowledged).toBe(0);
    port.rejectActive(new DOMException("aborted", "AbortError"));
    await settle();
    expect(queueSnapshot(KEY)?.items[0]?.status).toBe("cancelled");
    expect(queueSnapshot(KEY)?.items[0]?.acknowledged).toBe(0);
  });

  test("workspace_not_found is terminal and non-recoverable", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("old.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("workspaceNotFound");
    act(() => startUpload(SCOPE, id));
    await settle();
    const item = queueSnapshot(KEY)?.items[0]!;
    expect(item.status).toBe("error");
    expect(item.recoverable).toBe(false);
    expect(item.cancelIntent).toBe(false);
    expect(item.errorText).toContain("available");
  });

  test("removing an active upload keeps the row until the computer confirms; committed removal is local only", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("r.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    await act(async () => removeItem(SCOPE, id));
    await settle();
    // Unresolved handle row is retained, not silently dropped, and an explicit
    // cancel mutation was sent to the same session.
    expect(queueSnapshot(KEY)?.items).toHaveLength(1);
    expect(port.calls.some((call) => call.method === "cancel")).toBe(true);
    expect(queueSnapshot(KEY)?.items[0].status).toBe("cancelled");

    // Once terminal, removal drops only the local row; the file stays on disk.
    await act(async () => removeItem(SCOPE, id));
    expect(queueSnapshot(KEY)?.items).toHaveLength(0);
  });

  test("cancel aborts the real wire signal during a pending write, not just a cancel call", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("wire.txt", 8)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    expect(port.lastSignal).not.toBeNull();
    expect(port.lastSignal!.aborted).toBe(false);
    act(() => cancelUpload(SCOPE, id));
    await settle();
    // The AbortController installed by the scheduler was aborted, so the
    // in-flight write rejected; the then-retained checkpoint got one explicit
    // cancel mutation and the row settled cancelled (handle now cleared).
    expect(port.lastSignal!.aborted).toBe(true);
    expect(queueSnapshot(KEY)?.items[0].status).toBe("cancelled");
    expect(runtimeCheckpoint(KEY, id)).toBeNull();
    expect(port.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
  });

  test("cancel before the first checkpoint aborts preparation and never wires a cancel", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("pre.txt", 8)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("deferCheckpoint"); // still hashing: no checkpoint, no Begin
    await startJob(id);
    expect(runtimeCheckpoint(KEY, id)).toBeNull();
    act(() => cancelUpload(SCOPE, id));
    await settle();
    // Abort fired before any checkpoint was emitted, so no Begin went out and
    // the local cancel is exact: no cancel RPC, no retained handle.
    expect(port.lastSignal!.aborted).toBe(true);
    expect(queueSnapshot(KEY)?.items[0].status).toBe("cancelled");
    expect(runtimeCheckpoint(KEY, id)).toBeNull();
    expect(port.calls.some((call) => call.method === "cancel")).toBe(false);
  });

  test("a cancel issued after switching panes never wires to the wrong scope's session", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("roam.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    act(() => selectPane("p2"));
    act(() => cancelUpload(SCOPE, id));
    await settle();
    const item = queueSnapshot(KEY)!.items[0]!;
    // The owner is no longer valid (different pane), so the cancel is retained
    // and never sent to the wrong owner; the handle and intent are kept.
    expect(item.status).toBe("error");
    expect(item.cancelIntent).toBe(true);
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();
    expect(port.calls.some((call) => call.method === "cancel")).toBe(false);
  });

  test("removing a row with an unresolved checkpoint runs the cancel flow and keeps the row", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("unc.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("unknown");
    act(() => startUpload(SCOPE, id));
    await settle();
    const before = queueSnapshot(KEY)!.items[0]!;
    expect(before.status).toBe("error");
    expect(before.recoverable).toBe(true);
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();

    await act(async () => removeItem(SCOPE, id));
    await settle();
    // The unresolved remote upload is not silently dropped: the row survives
    // (reconciled via an explicit cancel mutation). A confirmed cancelled
    // response clears the now-gone handle.
    expect(queueSnapshot(KEY)?.items).toHaveLength(1);
    expect(queueSnapshot(KEY)?.items[0].status).toBe("cancelled");
    expect(runtimeCheckpoint(KEY, id)).toBeNull();
    expect(port.calls.some((call) => call.method === "cancel")).toBe(true);
  });

  test("startUpload refuses to re-begin while an unresolved checkpoint is recoverable", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("chk.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("unknown");
    act(() => startUpload(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("error");
    expect(queueSnapshot(KEY)?.items[0].recoverable).toBe(true);
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();

    port.setBehavior("commit");
    act(() => startUpload(SCOPE, id));
    await settle();
    // A fresh Begin would abandon the uncertain original, so it is refused.
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(1);
    expect(queueSnapshot(KEY)?.items[0].status).toBe("error");
  });

  test("explicit start after a missing handle clears the stale checkpoint and re-begins", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("gone.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("workspaceNotFound");
    act(() => startUpload(SCOPE, id));
    await settle();
    let item = queueSnapshot(KEY)!.items[0]!;
    expect(item.status).toBe("error");
    expect(item.recoverable).toBe(false);
    // Definite missing handle clears the stale reference at the transition.
    expect(runtimeCheckpoint(KEY, id)).toBeNull();

    port.setBehavior("commit");
    act(() => startUpload(SCOPE, id));
    await settle();
    item = queueSnapshot(KEY)!.items[0]!;
    expect(item.status).toBe("committed");
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(2);
  });

  test("internal/forbidden/conflict after onCheckpoint each retain a real handle", async () => {
    for (const code of ["internal", "forbidden", "conflict"] as const) {
      await act(async () => { await addPickedFiles(SCOPE, [file(`${code}.txt`, 4)]); });
      const row = queueSnapshot(KEY)!.items.at(-1)!;
      port.setBehavior(code); // onCheckpoint fired, then the RPC failed
      act(() => startUpload(SCOPE, row.localId));
      await settle();
      const item = queueSnapshot(KEY)!.items.find((i) => i.localId === row.localId)!;
      expect(item.status).toBe("error");
      expect(item.recoverable).toBe(false);
      expect(item.cancelIntent).toBe(false);
      // A non-recoverable failure after onCheckpoint is NOT terminal/missing:
      // the remote handle is still live and must be reconciled, not cleared.
      expect(runtimeCheckpoint(KEY, row.localId)).not.toBeNull();
    }
  });

  test("a non-recoverable failure with a retained handle cannot fresh-Begin or drop the row", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("ret.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("forbidden");
    act(() => startUpload(SCOPE, id));
    await settle();
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();

    // A fresh Begin would abandon the live handle: refused.
    port.setBehavior("commit");
    act(() => startUpload(SCOPE, id));
    await settle();
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(1);

    // Removal does not silently drop the live handle: it reconciles via cancel.
    port.setBehavior("forbidden");
    await act(async () => removeItem(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items).toHaveLength(1);
    expect(port.calls.some((call) => call.method === "cancel")).toBe(true);
  });

  test("a committed row is removed locally without any cancel call", async () => {
    const id = await uploadOne("done.txt", 5);
    expect(queueSnapshot(KEY)?.items[0].status).toBe("committed");
    await act(async () => removeItem(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items).toHaveLength(0);
    expect(port.calls.filter((call) => call.method === "cancel")).toHaveLength(0);
  });

  test("a read-only check that finds pending bytes stays paused and never writes or resumes", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("paused.txt", 6)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("unknown");
    act(() => startUpload(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("error");
    expect(queueSnapshot(KEY)?.items[0].recoverable).toBe(true);
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();

    // The computer reports the upload is still in progress.
    port.setBehavior("defer"); // inspect returns an 'uploading' state
    await act(async () => checkUpload(SCOPE, id));
    await settle();
    const item = queueSnapshot(KEY)!.items[0]!;
    // Paused and actionable, never active/uploading; no auto-resume or write.
    expect(item.status).toBe("error");
    expect(item.recoverable).toBe(true);
    expect(item.cancelIntent).toBe(false);
    expect(item.acknowledged).toBe(0);
    expect(port.calls.some((call) => call.method === "resume")).toBe(false);
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(1);
  });

  test("a handle lost during cancel ends honestly and permits a later explicit new upload", async () => {
    await act(async () => { await addPickedFiles(SCOPE, [file("lost.txt", 4)]); });
    const id = queueSnapshot(KEY)!.items[0].localId;
    port.setBehavior("defer");
    await startJob(id);
    expect(runtimeCheckpoint(KEY, id)).not.toBeNull();
    // The computer restarted and lost the handle: cancel and inspect report it gone.
    port.setBehavior("expiredCancel");
    act(() => cancelUpload(SCOPE, id));
    await settle();
    const item = queueSnapshot(KEY)!.items[0]!;
    // Honest EXPIRED state: cancel intent ends but we never claim the file was
    // deleted or cancelled; the stale handle is cleared.
    expect(item.status).toBe("error");
    expect(item.cancelIntent).toBe(false);
    expect(item.errorText).toContain("available");
    expect(runtimeCheckpoint(KEY, id)).toBeNull();

    // A later explicit upload is allowed and succeeds.
    port.setBehavior("commit");
    act(() => startUpload(SCOPE, id));
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("committed");
    expect(port.calls.filter((call) => call.method === "upload")).toHaveLength(2);
  });
});

describe("pick review under concurrency", () => {
  test("identical name/size files in one selection adopt one row each", async () => {
    // Name+size cannot establish identity: three DISTINCT File objects are all
    // adopted. Only the same File object repeats are skipped.
    paintGuided();
    await act(async () => {
      await addPickedFiles(SCOPE, [file("same.bin", 10), file("same.bin", 10), file("same.bin", 10)]);
    });
    expect(queueSnapshot(KEY)?.items).toHaveLength(3);
  });

  test("the same File object repeated in one selection is deduplicated", async () => {
    paintGuided();
    const picked = file("once.bin", 10);
    await act(async () => {
      await addPickedFiles(SCOPE, [picked, picked, picked]);
    });
    expect(queueSnapshot(KEY)?.items).toHaveLength(1);
  });

  test("two picks racing the port await both re-read the live queue before adopting", async () => {
    paintGuided();
    // Both calls suspend at the port lookup. Import resolution need not follow
    // call order; whichever resumes last must see the other's adopted rows.
    setAttachmentTransferPort(null);
    const first = addPickedFiles(SCOPE, Array.from({ length: 5 }, (_, i) => file(`a${i}`, 1)));
    const second = addPickedFiles(SCOPE, [file("b", 1)]);
    const results = await act(async () => Promise.all([first, second]));
    const accepted = queueSnapshot(KEY)!.items;
    const rejected = results.flat();
    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].code).toBe("tooManyFiles");
    expect([...accepted, ...rejected].map((item) => item.name).sort()).toEqual(["a0", "a1", "a2", "a3", "a4", "b"]);
    setAttachmentTransferPort(port);
  });

  test("enforces count, per-file and batch limits with explicit rejections", async () => {
    paintGuided();
    let rejections = await addPickedFiles(SCOPE, Array.from({ length: 6 }, (_, index) => file(`f${index}.txt`, 1)));
    expect(rejections).toHaveLength(1);
    expect(queueSnapshot(KEY)?.items).toHaveLength(5);
    rejections = await addPickedFiles(SCOPE, [file("big.bin", 20 * 1024 * 1024 + 1)]);
    expect(rejections[0].code).toBe("fileTooLarge");
    expect(queueSnapshot(KEY)?.items).toHaveLength(5);
  });

  test("will not start an upload from a sheet whose pane is no longer open", async () => {
    paintGuided();
    await act(async () => addPickedFiles(SCOPE, [file("x.txt", 1)]));
    act(() => selectPane("p2"));
    startUpload(SCOPE, queueSnapshot(KEY)!.items[0].localId);
    await settle();
    expect(queueSnapshot(KEY)?.items[0].status).toBe("queued");
    expect(port.calls).toEqual([]);
  });
});

test("current daemon fixture sanity", () => {
  expect(currentDaemonId()).toBe("d1");
});
