import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { createElement, renderReact, unmountReact } from "../../../../test-support/react-harness";
import { setScreen } from "../../../app/navigation-store";
import { setLang } from "../../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import type { LiveSession, PairResult } from "../../../lib/protocol/client";
import { setPhase, setSessionTransport } from "../../connection/connection-store";
import { applyCapabilities, clearCapabilities } from "../../operations/capabilities-store";
import { attachLiveSession, liveSession, setCredential } from "../../computers/catalog-store";
import { refreshHerdConfig, type RuntimeObservationPorts } from "../../connection/runtime";
import { selectPane, setFullTerminal } from "../session-store";
import { resetComposeDrafts } from "../drafts/compose-drafts";
import { AttachButton } from "./attach-button";
import { resetAttachmentPicker } from "./attach-picker";
import { setAttachmentTransferPort, settleTransferQueue } from "./attachments-controller";
import { attachmentScopeKey, queueSnapshot, resetAttachmentQueues } from "./attachments-store";
import { resetTrayActions } from "./attachments-tray-actions";
import type { AttachmentTransferPort } from "./attach-model";

const KEY = attachmentScopeKey({ daemonId: "d1", paneId: "p1" });
const OTHER_KEY = attachmentScopeKey({ daemonId: "d1", paneId: "p2" });
const GRANT = { ...NO_OPERATION_CAPABILITIES, upload_file: true } as never;

// Relay transport: rows stay queued, so no test here reaches the wire.
const port: AttachmentTransferPort = {
  limits: { maxFileBytes: 20 * 1024 * 1024, maxBatchBytes: 40 * 1024 * 1024, maxFiles: 5 },
  async upload() { throw new Error("no upload should occur during picking"); },
  async resume() { throw new Error("no resume should occur during picking"); },
  async inspect() { throw new Error("no inspect should occur during picking"); },
  async cancel() { throw new Error("no cancel should occur during picking"); },
};

/** GetConfig as the computer answers it, a moment after the page is back. */
const session = {
  isConnected: () => true,
  getConfig: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      protocol: 1, build: "v1.0.0", daemon_id: "d1", hostname: "herdbox", runtime: "herdr", vapid_public: "",
      submit_keys: ["Enter"], idle_pause_ms: 5000, push_delivery: "webpush", push_enabled: false,
      capabilities: { ...NO_OPERATION_CAPABILITIES, upload_file: true }, agent_kinds: [],
    };
  },
} as unknown as LiveSession;

const recoveryPorts: RuntimeObservationPorts = {
  acceptDaemonVersion: () => undefined,
  markDaemonConfigIncompatible: () => undefined,
  saveCredential: async () => undefined,
  reloadComputers: async () => undefined,
  refreshFromSession: async () => undefined,
  commitView: () => undefined,
  currentLive: liveSession,
  currentCredential: () => null,
};

function button(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(".attach-btn");
}

function nativeInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(".attach-native-input");
  if (!input) throw new Error("the picker input is missing");
  return input;
}

/** What the browser does when the system picker returns a selection. */
function deliver(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new happy.Event("change", { bubbles: true }) as unknown as Event);
}

/** Tap 📎; the picker is now "open" on the returned input. */
async function openPicker(): Promise<HTMLInputElement> {
  await act(async () => { button()!.click(); });
  return nativeInput();
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("en");
  setPhase("live"); setSessionTransport("relay");
  setScreen("pane");
  selectPane("p1");
  setFullTerminal(false);
  setCredential({ daemonId: "d1" } as unknown as PairResult);
  attachLiveSession(session);
  applyCapabilities(GRANT, []);
  resetComposeDrafts();
  resetAttachmentQueues();
  setAttachmentTransferPort(port);
  await act(async () => { renderReact(createElement(AttachButton)); });
});

afterEach(async () => {
  unmountReact();
  resetAttachmentPicker();
  resetTrayActions();
  setAttachmentTransferPort(null);
  attachLiveSession(null);
  setCredential(null);
  resetAttachmentQueues();
  resetComposeDrafts();
  await settleTransferQueue();
});

describe("attach picker", () => {
  test("a selection lands in the tray of the pane that opened the picker", async () => {
    const input = await openPicker();
    deliver(input, [new File(["a"], "a.txt")]);
    await settle();
    expect(queueSnapshot(KEY)?.items.map((row) => row.name)).toEqual(["a.txt"]);
  });

  test("a selection survives the button unmounting while the picker is open", async () => {
    const input = await openPicker();
    // Foreground recovery: capabilities clear before GetConfig lands.
    await act(async () => { clearCapabilities(); });
    expect(button()).toBeNull();
    expect(input.isConnected).toBe(true);
    deliver(input, [new File(["b"], "b.txt")]);
    await act(async () => { applyCapabilities(GRANT, []); });
    await settle();
    expect(queueSnapshot(KEY)?.items.map((row) => row.name)).toEqual(["b.txt"]);
  });

  test("a selection returned during the foreground recovery is adopted once GetConfig lands", async () => {
    const input = await openPicker();
    // Android hands the page back (visible) before it delivers the selection.
    let recovery!: Promise<boolean>;
    await act(async () => { recovery = refreshHerdConfig(recoveryPorts); });
    expect(button()).toBeNull();
    deliver(input, [new File(["e"], "e.txt")]);
    await act(async () => { await recovery; });
    await settle();
    expect(button()).not.toBeNull();
    expect(queueSnapshot(KEY)?.items.map((row) => row.name)).toEqual(["e.txt"]);
  });

  test("a selection never lands in a pane other than the one that opened the picker", async () => {
    const input = await openPicker();
    await act(async () => { selectPane("p2"); });
    deliver(input, [new File(["c"], "c.txt")]);
    await settle();
    expect(queueSnapshot(KEY)?.items ?? []).toHaveLength(0);
    expect(queueSnapshot(OTHER_KEY)?.items ?? []).toHaveLength(0);
  });

  test("a cancelled pick leaves nothing behind and the next pick still works", async () => {
    const input = await openPicker();
    deliver(input, []);
    await settle();
    expect(queueSnapshot(KEY)?.items ?? []).toHaveLength(0);
    expect(await openPicker()).toBe(input);
    deliver(input, [new File(["d"], "d.txt")]);
    await settle();
    expect(queueSnapshot(KEY)?.items.map((row) => row.name)).toEqual(["d.txt"]);
  });
});
