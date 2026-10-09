import { expectSameNode } from "../../../../test-support/node-identity";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import { setLang } from "../../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import type { LiveSession, PairResult } from "../../../lib/protocol/client";
import { applyOriginConfig, setNetworkMode, setPhase, setSessionTransport, setTransportSwitching } from "../../connection/connection-store";
import { applyCapabilities, clearCapabilities } from "../../operations/capabilities-store";
import { attachLiveSession, setCredential } from "../../computers/catalog-store";
import { selectPane } from "../session-store";
import { composeDraft as composeDraftText, setComposeDraft, setComposeLive } from "../compose-store";
import { resetComposeDrafts } from "../drafts/compose-drafts";
import { setAttachmentTransferPort, settleTransferQueue } from "./attachments-controller";
import { adoptIncoming, attachmentScopeKey, patchItem, queueSnapshot, resetAttachmentQueues, setRuntimeCheckpoint } from "./attachments-store";
import { resetAttachmentRecovery, setAttachmentJournalBackend } from "./attachments-recovery";
import { setThumbnailPreparer } from "./attachments-thumbnails";
import { setImagePreparer } from "./attachments-image";
import { resetAttachmentConnectAttempt } from "./attachments-connection";
import { resetTrayActions, UNDO_REMOVE_MS } from "./attachments-tray-actions";
import {
  acceptPastedFiles,
  dropBlockedAttachments,
  markAttachmentsSent,
  retryBlockedAttachments,
  sendAttachmentsState,
} from "./attachments-send";
import { AttachmentTray } from "./attachment-tray";
import type { AttachmentCheckpoint, AttachmentTransferPort } from "./attach-model";

const scope = { daemonId: "d_tray", paneId: "p1" };
const key = attachmentScopeKey(scope);
const pathOf = (name: string) => `/repo/.pairfob/attachments/aa/${name}`;
const file = (name: string, type = "text/plain") => new File([new Uint8Array(3)], name, { type });
const row = (name: string) => queueSnapshot(key)!.items.find((item) => item.name === name)!;
const checkpoint = (f: File): AttachmentCheckpoint => ({ uploadId: "12345678-1234-4234-8234-123456789abc", paneId: "p1", name: f.name, mime: f.type, size: f.size, sha256: "a".repeat(64) });

let session: LiveSession;
let port: AttachmentTransferPort;
let uploads: string[];
let cancels: number;
let switches: number;
let switchAction: () => Promise<void>;
let hold: Promise<void> | null;

async function pump(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function settle(): Promise<void> {
  await act(async () => { await pump(); await settleTransferQueue(); await pump(); });
}

/** A failed row, adopted and failed in one step so the tray's auto-start never sees it queued. */
function failedRow(name: string): void {
  setSessionTransport("relay");
  const [id] = adoptIncoming(key, scope, [file(name)]);
  patchItem(key, id, { status: "error", errorText: "x" });
  setSessionTransport("p2p");
}

function tray(): HTMLElement | null {
  return appRoot().querySelector<HTMLElement>(".attach-tray");
}

function chip(name: string): HTMLButtonElement {
  return appRoot().querySelector<HTMLButtonElement>(`.attach-chip[aria-label^="${name}"]`)!;
}

function buttonByText(text: string, root: ParentNode = appRoot()): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("en");
  resetAttachmentRecovery();
  resetAttachmentQueues();
  resetTrayActions();
  resetAttachmentConnectAttempt();
  setAttachmentJournalBackend({ put: async () => {}, remove: async () => {}, list: async () => [], clearDaemon: async () => {} });
  setPhase("live"); setScreen("pane"); selectPane("p1");
  setSessionTransport("p2p"); setTransportSwitching(false);
  applyOriginConfig({ protocol: 2, p2p: true }); setNetworkMode("auto");
  setCredential({ daemonId: scope.daemonId } as PairResult);
  switches = 0; uploads = []; cancels = 0; hold = null;
  switchAction = async () => { setSessionTransport("p2p"); };
  session = { isConnected: () => true, isChecking: () => false,
    switchTransport: async () => { switches++; await switchAction(); } } as unknown as LiveSession;
  attachLiveSession(session);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, upload_file: true }, []);
  resetComposeDrafts();
  setComposeLive(false);
  setComposeDraft("");
  setThumbnailPreparer(async () => null);
  setImagePreparer(async (f) => ({ file: f, originalBytes: f.size, changed: false, reason: "small" }));
  port = {
    limits: { maxFileBytes: 20971520, maxBatchBytes: 41943040, maxFiles: 5 },
    upload: async (_s, _p, f, options) => {
      uploads.push(f.name);
      await options?.onCheckpoint?.(checkpoint(f));
      if (hold) await hold;
      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      options?.onProgress?.(f.size, f.size);
      return { upload_id: "u", state: "committed", offset: f.size, size: f.size, sha256: "a".repeat(64), chunk_bytes: 32768, path: pathOf(f.name) };
    },
    resume: async (_s, cp, f) => ({ upload_id: cp.uploadId, state: "committed", offset: f.size, size: f.size, sha256: "a".repeat(64), chunk_bytes: 32768, path: pathOf(f.name) }),
    inspect: async (_s, cp) => ({ upload_id: cp.uploadId, state: "uploading", offset: 1, size: cp.size, sha256: cp.sha256, chunk_bytes: 32768 }),
    cancel: async (_s, cp) => { cancels++; return { upload_id: cp.uploadId, state: "cancelled", offset: 0, size: cp.size, sha256: cp.sha256, chunk_bytes: 32768 }; },
  };
  setAttachmentTransferPort(port);
});

afterEach(async () => {
  hold = null;
  closeTestDialogs();
  unmountReact();
  resetTrayActions();
  resetAttachmentRecovery();
  resetAttachmentQueues();
  await settleTransferQueue();
  setImagePreparer(null);
  setThumbnailPreparer(null);
  setAttachmentTransferPort(null);
  attachLiveSession(null);
  setCredential(null);
  clearCapabilities();
  resetComposeDrafts();
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("attachment tray", () => {
  test("renders nothing without attachments; compact shrinks the thumbnails", async () => {
    renderReact(<AttachmentTray />);
    expect(tray()).toBeNull();
    setSessionTransport("relay");
    await act(async () => { adoptIncoming(key, scope, [file("a.txt")]); });
    expect(tray()).not.toBeNull();
    expect(tray()!.classList.contains("is-compact")).toBe(false);
    unmountReact();
    renderReact(<AttachmentTray compact />);
    expect(tray()!.classList.contains("is-compact")).toBe(true);
  });

  test("on a phone the count scrolls along inside the strip", async () => {
    renderReact(<AttachmentTray />);
    setSessionTransport("relay");
    await act(async () => { adoptIncoming(key, scope, [file("a.txt")]); });
    expect(tray()!.classList.contains("is-beside")).toBe(false);
    expect(tray()!.querySelector(".attach-meta-col")!.parentElement!.classList.contains("attach-strip")).toBe(true);
  });

  test("beside the list the count leaves the strip, so a narrow column cannot run it off its edge", async () => {
    happy.happyDOM.setWindowSize({ width: 820, height: 1180 });
    renderReact(<AttachmentTray />);
    setSessionTransport("relay");
    await act(async () => { adoptIncoming(key, scope, [file("a.txt")]); });
    expect(tray()!.classList.contains("is-beside")).toBe(true);
    const meta = tray()!.querySelector(".attach-meta-col")!;
    expectSameNode(meta.parentElement, tray());
    expect(tray()!.querySelector(".attach-strip .attach-meta-col")).toBeNull();
    // Still one status region, after the thumbnails it describes.
    expect(tray()!.querySelectorAll(".attach-meta-col")).toHaveLength(1);
    expect(meta.previousElementSibling!.classList.contains("attach-strip")).toBe(true);
    expect(meta.textContent).toContain("1/5");
  });

  test("pasted files upload on their own and become ready paths in tray order", async () => {
    renderReact(<AttachmentTray />);
    let accepted = false;
    await act(async () => { accepted = acceptPastedFiles([file("b.txt"), file("a.txt")]); });
    expect(accepted).toBe(true);
    await settle();
    expect(uploads).toEqual(["b.txt", "a.txt"]);
    expect(chip("b.txt").classList.contains("is-ready")).toBe(true);
    expect(sendAttachmentsState()).toMatchObject({ readyPaths: [pathOf("b.txt"), pathOf("a.txt")], pending: 0, blocked: 0, total: 2 });
    expect(tray()!.textContent).toContain("Attaches 2 paths on send");
    // Stable identity while nothing changed.
    expect(sendAttachmentsState()).toBe(sendAttachmentsState());
  });

  test("paste is refused without upload support", () => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    expect(acceptPastedFiles([file("a.txt")])).toBe(false);
    expect(acceptPastedFiles([])).toBe(false);
  });

  test("on Relay rows wait, the tray leads with Connect, and connecting starts them", async () => {
    setSessionTransport("relay");
    renderReact(<AttachmentTray />);
    await act(async () => { adoptIncoming(key, scope, [file("a.txt")]); });
    expect(chip("a.txt").classList.contains("is-waiting")).toBe(true);
    expect(sendAttachmentsState()).toMatchObject({ blocked: 1, waitingP2P: true, readyPaths: [] });
    const connect = buttonByText("Connect")!;
    expect(tray()!.textContent).toContain("Uploads need a direct connection");
    act(() => { connect.click(); connect.click(); });
    await settle();
    expect(switches).toBe(1);
    expect(uploads).toEqual(["a.txt"]);
    expect(sendAttachmentsState().readyPaths).toEqual([pathOf("a.txt")]);
  });

  test("a failed connection keeps the file and says so", async () => {
    setSessionTransport("relay");
    switchAction = async () => { throw Error("no"); };
    renderReact(<AttachmentTray />);
    await act(async () => { adoptIncoming(key, scope, [file("a.txt")]); });
    await act(async () => { buttonByText("Connect")!.click(); await pump(); });
    expect(tray()!.textContent).toContain("Direct connection failed");
    expect(queueSnapshot(key)!.items).toHaveLength(1);
    expect(uploads).toEqual([]);
  });

  test("× removes at once, cancels the running upload, and undo brings it back", async () => {
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("a.txt")]); await pump(); });
    expect(uploads).toEqual(["a.txt"]);
    await act(async () => { appRoot().querySelector<HTMLButtonElement>(".attach-chip-x")!.click(); });
    expect(appRoot().querySelector(".attach-chip")).toBeNull();
    expect(tray()!.textContent).toContain("Removed a.txt; upload cancelled");
    expect(sendAttachmentsState().total).toBe(0);
    release(); hold = null;
    await settle();
    expect(cancels).toBe(1);
    await act(async () => { buttonByText("Undo")!.click(); });
    await settle();
    expect(chip("a.txt")).toBeTruthy();
    expect(uploads).toEqual(["a.txt", "a.txt"]);
    expect(chip("a.txt").classList.contains("is-ready")).toBe(true);
  });

  test("without undo the row is dropped when the offer expires", async () => {
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("a.txt")]); });
    await settle();
    const realSetTimeout = globalThis.setTimeout;
    await act(async () => { appRoot().querySelector<HTMLButtonElement>(".attach-chip-x")!.click(); });
    await act(async () => { await new Promise((resolve) => realSetTimeout(resolve, UNDO_REMOVE_MS + 50)); });
    expect(queueSnapshot(key)!.items).toHaveLength(0);
    expect(tray()).toBeNull();
  }, UNDO_REMOVE_MS + 5000);

  test("tapping a thumbnail opens an action bar with only the valid actions", async () => {
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("a.txt")]); });
    await settle();
    act(() => chip("a.txt").click());
    const pop = appRoot().querySelector<HTMLElement>(".attach-pop")!;
    expect([...pop.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Preview", "Put in message", "Remove"]);
    act(() => chip("a.txt").click());
    expect(appRoot().querySelector(".attach-pop")).toBeNull();
  });

  test("a failed row is drawn failed and its action bar leads with the retry and the reason", async () => {
    const [id] = adoptIncoming(key, scope, [file("a.txt")]);
    patchItem(key, id, { status: "error", errorText: "Disk is full" });
    renderReact(<AttachmentTray />);
    expect(chip("a.txt").classList.contains("is-failed")).toBe(true);
    act(() => chip("a.txt").click());
    const pop = appRoot().querySelector<HTMLElement>(".attach-pop")!;
    expect(pop.textContent).toContain("Disk is full");
    expect(pop.querySelector("button")!.textContent).toBe("Try again");
    await act(async () => { pop.querySelector<HTMLButtonElement>("button")!.click(); });
    await settle();
    expect(row("a.txt").status).toBe("committed");
  });

  test("restored rows wait for the reader: continue all or clear", async () => {
    // Restored rows arrive already marked (restoreAttachmentRecord).
    const [a, b] = adoptIncoming(key, scope, [file("a.txt"), file("b.txt")]);
    patchItem(key, a, { restored: true });
    setRuntimeCheckpoint(key, b, checkpoint(file("b.txt")));
    patchItem(key, b, { restored: true, status: "error", recoverable: true });
    renderReact(<AttachmentTray />);
    await settle();
    expect(uploads).toEqual([]);
    expect(tray()!.textContent).toContain("2 files from last time did not finish");
    expect(chip("a.txt").classList.contains("is-paused")).toBe(true);
    await act(async () => { buttonByText("Continue all")!.click(); });
    await settle();
    expect(row("a.txt").status).toBe("committed");
    expect(row("b.txt").status).toBe("committed");
    expect(tray()!.textContent).not.toContain("did not finish");
  });

  test("put in message: the path moves into the draft and is not appended again", async () => {
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("a.txt"), file("b.txt")]); });
    await settle();
    act(() => chip("a.txt").click());
    await act(async () => { buttonByText("Put in message")!.click(); await pump(); });
    expect(row("a.txt").inserted).toBe(true);
    expect(sendAttachmentsState().readyPaths).toEqual([pathOf("b.txt")]);
    expect(appRoot().querySelector(`.attach-chip[aria-label^="a.txt"] .attach-chip-tag`)).not.toBeNull();
    // Taking it out removes the text and appends it on send again.
    act(() => chip("a.txt").click());
    await act(async () => { buttonByText("Take out of message")!.click(); });
    expect(row("a.txt").inserted).toBe(false);
    expect(sendAttachmentsState().readyPaths).toEqual([pathOf("a.txt"), pathOf("b.txt")]);
    expect(composeDraftText()).not.toContain(pathOf("a.txt"));
  });

  test("a path deleted from the draft by hand is appended on send again", async () => {
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("a.txt")]); });
    await settle();
    act(() => chip("a.txt").click());
    await act(async () => { buttonByText("Put in message")!.click(); await pump(); });
    expect(sendAttachmentsState().readyPaths).toEqual([]);
    act(() => setComposeDraft("nothing here"));
    expect(sendAttachmentsState().readyPaths).toEqual([pathOf("a.txt")]);
  });

  test("the send contract: mark sent clears ready rows, drop removes blocked ones, retry continues them", async () => {
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("a.txt")]); });
    await settle();
    await act(async () => { failedRow("b.txt"); });
    expect(sendAttachmentsState()).toMatchObject({ blocked: 1, blockedNames: ["b.txt"], readyPaths: [pathOf("a.txt")] });
    await act(async () => { retryBlockedAttachments(); });
    await settle();
    expect(row("b.txt").status).toBe("committed");
    await act(async () => { failedRow("c.txt"); });
    await act(async () => { dropBlockedAttachments(); });
    expect(sendAttachmentsState()).toMatchObject({ blocked: 0, total: 2 });
    await act(async () => { markAttachmentsSent(); });
    expect(queueSnapshot(key)!.items).toHaveLength(0);
    expect(sendAttachmentsState().total).toBe(0);
  });

  test("changing quality on a finished image uploads it again in place", async () => {
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("p.jpg", "image/jpeg")]); });
    await settle();
    expect(row("p.jpg")).toMatchObject({ status: "committed", compressionMode: "smart" });
    act(() => chip("p.jpg").click());
    await act(async () => { buttonByText("Use original")!.click(); });
    await settle();
    expect(uploads).toEqual(["p.jpg", "p.jpg"]);
    expect(row("p.jpg")).toMatchObject({ status: "committed", compressionMode: "original" });
    expect(queueSnapshot(key)!.items).toHaveLength(1);
  });

  test("preview opens a full-screen viewer that moves between tray items", async () => {
    renderReact(<AttachmentTray />);
    await act(async () => { acceptPastedFiles([file("a.txt"), file("b.txt")]); });
    await settle();
    act(() => chip("a.txt").click());
    act(() => buttonByText("Preview")!.click());
    const viewer = document.querySelector<HTMLDialogElement>("dialog.attach-viewer")!;
    expect(viewer).toBeTruthy();
    expect(viewer.querySelector(".attach-viewer-name")!.textContent).toBe("a.txt");
    act(() => viewer.querySelector<HTMLButtonElement>('[aria-label="Next attachment"]')!.click());
    expect(viewer.querySelector(".attach-viewer-name")!.textContent).toBe("b.txt");
    act(() => buttonByText("Info", viewer)!.click());
    expect(viewer.querySelector(".attach-info")!.textContent).toContain(pathOf("b.txt"));
  });
});
