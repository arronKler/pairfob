import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import {
  pairingStore, pairAbortHandle, resetPairingInput, pairCodeDraft, pairErrorTarget,
  setPairManualOpen, setPairFailure,
} from "./form-store";
import {
  applyPairingFragment, applyOriginConfig, phase, setPhase, p2pEnabled,
} from "../connection/connection-store";
import { attachLiveSession, liveSession, setAddingComputer, setCredential, setComputers } from "../computers/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { applySnapshot } from "../dashboard/catalog-store";
import { resetPaneView, selectPane } from "../session/session-store";
import { clearNotice, showStatus, visibleNotice } from "../../app/notices-store";
import { stopPolling } from "../connection/controller";
import { setLang } from "../../lib/i18n";
import * as originalClient from "../../lib/protocol/client";
import * as credentials from "../../lib/credentials";
import * as scanner from "../../lib/pairing-scanner";
import * as telemetry from "../../lib/telemetry";
import { ConnectScreen } from "../../pages/connect/connect-page";
import { beginPairing, cancelPairing, retirePairingWork } from "./actions";

/**
 * Landing publication boundary.
 *
 * The abort release (`setPairAbort(null)`) and the rest of a cancel/error
 * landing publish as two transactions with one ownership revalidation between
 * them. A pairingStore subscriber that reacts to the released abort takes the
 * screen in one of the ways production allows — a live connection, a new
 * attempt cancelled back to a null handle, or a new intent that fails local
 * validation — and the old landing must not overwrite its phase, notice, draft
 * or error rail. Mirrors pairing-landing-pi-null-owner.test.ts and
 * pairing-landing-pi-local-rejection.test.ts at controller+page level.
 */

let pairCall: (...args: unknown[]) => Promise<unknown>, saveCall: null | (() => Promise<void>);
let handshakeCalls = 0, resumeCalls = 0, persisted: unknown[] = [];
mock.module("../../lib/protocol/client", () => ({
  ...originalClient,
  pairOverWS: (...args: unknown[]) => { handshakeCalls += 1; return pairCall(...args); },
  sessionOverWS: async () => { resumeCalls += 1; throw new originalClient.ProtocolError("disconnected", "first connection lost"); },
}));
mock.module("../../lib/credentials", () => ({
  ...credentials,
  saveCredential: async (pair: unknown) => { persisted.push(pair); if (saveCall) await saveCall(); },
  loadCatalog: async () => ({ credentials: [...persisted], lastUsedDaemonId: null }),
  rememberLastUsed: async () => {},
}));
mock.module("../../lib/pairing-scanner", () => ({ ...scanner, scanPairingCode: async () => null }));

const scanned = { v: 2, code: "ABCDEFGH", pairRef: "ref", daemonId: "d_aaaaaaaaaaaaaaaaaaaa", fingerprint: "fingerprint" };
const paired = {
  daemonId: scanned.daemonId, deviceId: "dev_phone", psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
  relayOrigin: "https://pairfob.com", fp: "fp", label: "Phone", createdAt: 1,
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const resource = () => ({ isConnected: () => true, close() {}, onEvent: () => () => {} });

let root: Root | null = null;
let hostEl: HTMLElement | null = null;
function paint() {
  if (!hostEl) {
    hostEl = document.createElement("div");
    document.body.append(hostEl);
    root = createRoot(hostEl);
  }
  // StrictMode ConnectScreen, the same runtime environment the original
  // landing-boundary cases ran under (mount/unmount reclaim replay).
  act(() => { root!.render(createElement(StrictMode, null, createElement(ConnectScreen))); });
}
function unmountStrict() {
  act(() => { root?.unmount(); });
  root = null;
  hostEl?.remove();
  hostEl = null;
}

function baselines() {
  act(() => {
    setPhase("connect");
    setScreen("home");
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    setAddingComputer(false);
    // Session pane/view baseline: clear the pane id, then reset full-terminal/
    // agent-chat/compose/trace (resetPaneView does not clear paneId).
    selectPane("");
    resetPaneView();
    // Pairing input baseline: no abort/draft/awaiting/error (reset), failure
    // cleared, then manual open for the connect page.
    resetPairingInput();
    setPairFailure(null, null);
    setPairManualOpen(true);
    clearNotice();
    applySnapshot({ workspaces: [], panes: [] });
    // Origin protocol 2 (the scan path), from the configured origin.
    applyOriginConfig({ protocol: 2, p2p: p2pEnabled() });
    // The scan path begins from a captured fragment (does not itself set
    // origin protocol).
    applyPairingFragment({ ...scanned });
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  baselines();
  setLang("zh");
  persisted = []; saveCall = null; resumeCalls = 0; handshakeCalls = 0;
  pairCall = async () => { throw new Error("unexpected pairing"); };
  telemetry.setTelemetrySender(() => {});
});

afterEach(async () => {
  await act(async () => {
    cancelPairing();
    retirePairingWork();
    unmountStrict();
    // Named value cleanup (store.reset only drops subscribers).
    resetPairingInput();
    setPairFailure(null, null);
    clearNotice();
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    setPhase("boot");
    setScreen("home");
  });
  stopPolling();
  telemetry.resetTelemetry();
  await happy.happyDOM.abort();
});

type ReplacementKind = "live" | "beginCancel" | "localReject";

for (const failure of [false, true]) {
  for (const kind of ["live", "beginCancel", "localReject"] as ReplacementKind[]) {
    test(`${failure ? "error" : "cancel"} landing at the abort release cannot overwrite a ${kind} replacement`, async () => {
      const first = deferred<unknown>();
      const next = deferred<unknown>();
      let oldTask!: Promise<void>;
      pairCall = () => first.promise;
      act(() => { paint(); oldTask = beginPairing(scanned.code); });
      let newTask: Promise<void> | undefined;
      let replacementLive: ReturnType<typeof resource> | undefined;
      let changed = false;
      const stop = pairingStore.subscribe(() => {
        if (changed || pairingStore.get().pairAbort !== null) return;
        changed = true;
        if (kind === "live") {
          // Another connection owns the screen; pairing work retires with it.
          retirePairingWork();
          replacementLive = resource();
          attachLiveSession(replacementLive as never);
          setCredential({ ...paired, daemonId: "replacement" });
          setPhase("live");
          showStatus("live replacement", true);
          return;
        }
        setPhase("connect");
        if (kind === "beginCancel") {
          // A new actual attempt is cancelled back to a null handle.
          pairCall = () => next.promise;
          newTask = beginPairing(scanned.code);
          cancelPairing();
          showStatus("cancelled replacement", true);
          return;
        }
        // A new intent fails local validation before any transport starts.
        newTask = beginPairing("X");
        showStatus("invalid replacement", true);
      });
      try {
        if (failure) {
          await act(async () => { first.reject(new originalClient.ProtocolError("pairing_failed", "old handshake failed")); await oldTask; });
        } else {
          act(() => cancelPairing());
        }
      } finally {
        stop();
      }
      expect(changed).toBeTrue();
      if (kind === "live") {
        expect(liveSession()).toBe(replacementLive);
        expect(phase()).toBe("live");
        expect(visibleNotice()?.text).toBe("live replacement");
        expect(handshakeCalls).toBe(1);
      } else if (kind === "beginCancel") {
        expect(handshakeCalls).toBe(2);
        expect(phase()).toBe("connect");
        expect(visibleNotice()?.text).toBe("cancelled replacement");
      } else {
        expect(handshakeCalls).toBe(1);
        expect(phase()).toBe("connect");
        expect(pairCodeDraft()).toBe("X");
        expect(pairErrorTarget()).toBe("code");
        expect(visibleNotice()?.text).toBe("invalid replacement");
      }
      retirePairingWork();
      await act(async () => {
        if (!failure) first.resolve(paired);
        next.resolve(paired);
        await oldTask;
        await newTask;
      });
      expect(resumeCalls).toBe(0);
    });
  }
}

// The original abort-release counterexample: an in-flight replacement with a
// live handle must keep its handle, phase and notice.
for (const failure of [false, true]) {
  test(`${failure ? "error" : "cancel"} landing at the abort release cannot overwrite an in-flight replacement attempt`, async () => {
    const first = deferred<unknown>();
    const next = deferred<unknown>();
    let oldTask!: Promise<void>;
    pairCall = () => first.promise;
    act(() => { paint(); oldTask = beginPairing(scanned.code); });
    let newTask: Promise<void> | undefined;
    let newAbort: AbortController | undefined;
    let changed = false;
    const stop = pairingStore.subscribe(() => {
      if (changed || pairingStore.get().pairAbort !== null) return;
      changed = true;
      setPhase("connect");
      pairCall = () => next.promise;
      newTask = beginPairing(scanned.code);
      newAbort = pairAbortHandle()!;
      showStatus("new attempt at abort release", true);
    });
    try {
      if (failure) {
        await act(async () => { first.reject(new originalClient.ProtocolError("pairing_failed", "old handshake failed")); await oldTask; });
      } else {
        act(() => cancelPairing());
      }
    } finally {
      stop();
    }
    expect(changed).toBeTrue();
    expect(handshakeCalls).toBe(2);
    expect(pairAbortHandle()).toBe(newAbort);
    expect(newAbort?.signal.aborted).toBeFalse();
    expect(phase()).toBe("pairing");
    expect(visibleNotice()?.text).toBe("new attempt at abort release");
    retirePairingWork();
    await act(async () => {
      if (!failure) first.resolve(paired);
      next.resolve(paired);
      await oldTask;
      await newTask;
    });
    expect(resumeCalls).toBe(0);
  });
}
