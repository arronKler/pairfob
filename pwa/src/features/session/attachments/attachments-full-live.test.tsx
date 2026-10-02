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
import { setPhase, setSessionTransport } from "../../connection/connection-store";
import { applyCapabilities } from "../../operations/capabilities-store";
import { attachLiveSession, setCredential } from "../../computers/catalog-store";
import { selectPane, setFullTerminal } from "../session-store";
import { composeLive, setComposeDraft, setComposeLive } from "../compose-store";
import { resetComposeDrafts } from "../drafts/compose-drafts";
import { FullTerminalPad } from "../full-terminal/full-terminal-pad";
import type { FullTerminalControlsOptions } from "../full-terminal/full-terminal-compose";
import {
  addPickedFiles,
  setAttachmentTransferPort,
  startUpload,
} from "./attachments-controller";
import { resetAttachmentPicker } from "./attach-picker";
import { insertPaths } from "./attachments-insertion";
import { resetAttachmentQueues, attachmentScopeKey, queueSnapshot } from "./attachments-store";
import type { AttachmentTransferOptions, AttachmentTransferPort, UploadStateLike } from "./attach-model";

const SCOPE = { daemonId: "d1", paneId: "p1" } as const;
const KEY = attachmentScopeKey(SCOPE);
const COMMITTED_PATH = "/tmp/demo/.pairfob/attachments/cc/notes.txt";

const sent: Array<{ kind: string; payload: unknown }> = [];
const session = {
  isConnected: () => true,
  sendText: async (...args: unknown[]) => { sent.push({ kind: "sendText", payload: args[0] }); },
  sendKeys: async (...args: unknown[]) => { sent.push({ kind: "sendKeys", payload: args[0] }); },
} as unknown as LiveSession;

function keyboard() {
  let open = false;
  return {
    toggle: () => { open = !open; },
    open: () => { open = true; },
    close: () => { open = false; },
    isOpen: () => open,
  };
}

let port: AttachmentTransferPort;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("en");
  setPhase("live"); setSessionTransport("p2p");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(true);
  setCredential({ daemonId: "d1" } as unknown as PairResult);
  attachLiveSession(session);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, upload_file: true } as never, []);
  resetComposeDrafts();
  resetAttachmentQueues();
  setComposeDraft("");
  sent.length = 0;
  port = {
    limits: { maxFileBytes: 20 * 1024 * 1024, maxBatchBytes: 40 * 1024 * 1024, maxFiles: 5 },
    async upload(_s, paneId, file, options?: AttachmentTransferOptions) {
      const state: UploadStateLike = {
        upload_id: "u1", state: "committed", offset: file.size, size: file.size,
        sha256: "a".repeat(64), chunk_bytes: 32768, path: COMMITTED_PATH,
      };
      await options?.onCheckpoint?.({
        uploadId: "u1", paneId, name: file.name, size: file.size,
        sha256: "a".repeat(64), mime: file.type || "application/octet-stream",
      });
      options?.onProgress?.(file.size, file.size);
      return state;
    },
    resume: async () => { throw new Error("not used"); },
    inspect: async () => { throw new Error("not used"); },
    cancel: async () => { throw new Error("not used"); },
  };
  setAttachmentTransferPort(port);
  await act(async () => setComposeLive(true));
});

afterEach(async () => {
  closeTestDialogs();
  unmountReact();
  resetAttachmentPicker();
  setAttachmentTransferPort(null);
  attachLiveSession(null);
  setCredential(null);
  setFullTerminal(false);
  setComposeDraft("");
  await act(async () => setComposeLive(false));
  resetAttachmentQueues();
  resetComposeDrafts();
  appRoot().replaceChildren();
});

function paintPad(): { sendCompose: (text: string, enter: boolean) => boolean; sendKey: (key: string) => void } {
  const sendCompose = (text: string, enter: boolean): boolean => {
    sent.push({ kind: "sendCompose", payload: { text, enter } });
    return true;
  };
  const sendKey = (key: string): void => {
    sent.push({ kind: "sendKey", payload: key });
  };
  const options: FullTerminalControlsOptions = { sendKey, sendCompose, keyboard: keyboard(), desk: false };
  renderReact(<FullTerminalPad options={options} />);
  return { sendCompose, sendKey };
}

describe("full terminal live mode attachment entry", () => {
  test("mounts an accessible attachment entry in live mode and no batch field/duplicate button", () => {
    paintPad();
    const liveEntry = appRoot().querySelector(".full-terminal-live-actions .attach-btn");
    expect(liveEntry).not.toBeNull();
    expect(liveEntry?.getAttribute("aria-label")).toBe("Add attachments");
    expect(appRoot().querySelector(".full-terminal-compose-input")).toBeNull();
    // Exactly one attach affordance in the whole pad.
    expect(appRoot().querySelectorAll(".attach-btn")).toHaveLength(1);
  });

  test("opens the system picker directly from live mode (no intermediate sheet)", () => {
    paintPad();
    // The input is page-owned (attach-picker), so the open is observed on the class.
    const proto = happy.HTMLInputElement.prototype as unknown as HTMLInputElement;
    const own = Object.getOwnPropertyDescriptor(proto, "click");
    let opened = 0;
    proto.click = function (this: HTMLInputElement) { if (this.type === "file") opened += 1; };
    try {
      act(() => appRoot().querySelector<HTMLButtonElement>(".full-terminal-live-actions .attach-btn")!.click());
    } finally {
      if (own) Object.defineProperty(proto, "click", own);
      else delete (proto as { click?: unknown }).click;
    }
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].multiple).toBe(true);
    expect(opened).toBe(1);
    expect(document.querySelector("dialog")).toBeNull();
  });

  test("inserting a committed path switches the real parent to batch compose without sending anything", async () => {
    paintPad();
    expect(composeLive()).toBe(true);

    await act(async () => {
      await addPickedFiles(SCOPE, [new File([new Uint8Array(4)], "notes.txt")]);
      await startUpload(SCOPE, queueSnapshot(KEY)!.items[0].localId);
    });
    expect(queueSnapshot(KEY)?.items[0].status).toBe("committed");

    await act(async () => { expect(await insertPaths(SCOPE)).toBe(true); });

    // The live entry unmounts; the batch field mounts exactly once and holds the path.
    expect(composeLive()).toBe(false);
    expect(appRoot().querySelector(".full-terminal-live-actions")).toBeNull();
    const fields = appRoot().querySelectorAll<HTMLTextAreaElement>(".full-terminal-compose-input");
    expect(fields).toHaveLength(1);
    expect(fields[0].value).toBe(COMMITTED_PATH);
    expect(appRoot().querySelectorAll(".attach-btn")).toHaveLength(1);
    // No PTY text, keys or prompts were sent by the upload or the mode switch.
    expect(sent).toEqual([]);
  });

  test("returns to a live entry without duplicating the batch button", async () => {
    paintPad();
    await act(async () => {
      await addPickedFiles(SCOPE, [new File([new Uint8Array(3)], "a.txt")]);
      await startUpload(SCOPE, queueSnapshot(KEY)!.items[0].localId);
    });
    await act(async () => insertPaths(SCOPE));
    expect(appRoot().querySelectorAll(".attach-btn")).toHaveLength(1);

    // Reader switches back to live typing explicitly; batch unmounts, live entry returns.
    await act(async () => setComposeLive(true));
    expect(appRoot().querySelector(".full-terminal-compose-input")).toBeNull();
    expect(appRoot().querySelector(".full-terminal-live-actions .attach-btn")).not.toBeNull();
    expect(appRoot().querySelectorAll(".attach-btn")).toHaveLength(1);
  });
});
