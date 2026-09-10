import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { connectionStore, applyPairingFragment, applyOriginConfig, phase, setPhase, p2pEnabled } from "../connection/connection-store";
import { attachLiveSession, setAddingComputer, setCredential, setComputers } from "../computers/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { pairingStore, resetPairingInput, setPairManualOpen, setPairFailure } from "./form-store";
import { applySnapshot } from "../dashboard/catalog-store";
import { resetPaneView, selectPane } from "../session/session-store";
import { clearNotice } from "../../app/notices-store";
import { setLang } from "../../lib/i18n";
import { stopPolling } from "../connection/controller";
import * as originalClient from "../../lib/protocol/client";
import * as credentials from "../../lib/credentials";
import * as scanner from "../../lib/pairing-scanner";
import * as telemetry from "../../lib/telemetry";
import { ConnectScreen } from "../../pages/connect/connect-page";
import { beginPairing, cancelPairing, retirePairingWork } from "./actions";
import { pairingWorkId } from "./work";

/**
 * StrictMode generation reclaim (inherited pairing lifecycle follow-up).
 *
 * StrictMode releases a ConnectScreen instance, then replays the same instance
 * so effect side effects are re-runnable. `releasePairingPage` saves the
 * attempt generation and `claimPairingPage` restores it for the replayed
 * instance — ordinary same-instance replay must keep the original in-flight
 * attempt current. But when the released page's own transport abort starts a
 * real new intent during the release window (cleanup aborts the handshake this
 * page started; the abort callback begins a genuine B attempt), that explicit
 * later intent must not be undone by the older reclaim snapshot: restoring
 * `workAtRelease` would rewind the generation past B and discard B's success.
 *
 * The main test drives the actual abort callback through a real beginPairing(B)
 * and asserts the generation is kept AND B persists + resumes. The control
 * reproduces ordinary replay with no intervening intent: the released attempt
 * must still be restored and land its own success.
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
let root: Root | null = null;
let renderHost: HTMLElement | null = null;
function paint() {
  if (!renderHost) {
    renderHost = document.createElement("div");
    document.body.append(renderHost);
    root = createRoot(renderHost);
  }
  act(() => { root!.render(createElement(StrictMode, null, createElement(ConnectScreen))); });
}
function renderStrict(...extra: React.ReactNode[]) {
  if (!renderHost) {
    renderHost = document.createElement("div");
    document.body.append(renderHost);
    root = createRoot(renderHost);
  }
  act(() => { root!.render(createElement(StrictMode, null, createElement(ConnectScreen), ...extra)); });
}
function unmountStrict() {
  act(() => { root?.unmount(); });
  root = null;
  renderHost?.remove();
  renderHost = null;
}

function baselines() {
  act(() => {
    setPhase("connect");
    setScreen("home");
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    setAddingComputer(false);
    // Clear pane id, then full-terminal/agent-chat/compose/trace.
    selectPane("");
    resetPaneView();
    // Pairing input baseline: no abort/draft/awaiting/error (reset), failure
    // cleared, then manual open for the connect page.
    resetPairingInput();
    setPairFailure(null, null);
    setPairManualOpen(true);
    clearNotice();
    applySnapshot({ workspaces: [], panes: [] });
    applyOriginConfig({ protocol: 2, p2p: p2pEnabled() });
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
    // Named value cleanup; store.reset would only drop subscribers.
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

/**
 * Starts one real pairing attempt once, mirroring a mounted screen's own effect.
 * The per-test runner is captured so each test issues its own attempt.
 */
let startRunner: (() => void) | null = null;
function StartIntent() {
  const started = useRef(false);
  useLayoutEffect(() => {
    if (!started.current) {
      started.current = true;
      startRunner?.();
    }
  }, []);
  return null;
}

test("StrictMode replay does not rewind the generation past a real new intent started by the released transport abort", async () => {
  const first = deferred<unknown>();
  const next = deferred<unknown>();
  let oldTask: Promise<void> | undefined;
  let newTask: Promise<void> | undefined;
  let newGeneration: number | undefined;
  let oldAborted = false;
  // The released page's cleanup aborts the handshake this page started; the
  // abort callback then starts a genuine B attempt on the same page.
  pairCall = (_relay, _attach, _code, options: { signal: AbortSignal }) => {
    options.signal.addEventListener("abort", () => {
      oldAborted = true;
      setPhase("connect");
      pairCall = () => next.promise;
      newTask = beginPairing(scanned.code);
      newGeneration = pairingWorkId();
      first.reject(new originalClient.ProtocolError("pairing_cancelled", "aborted by page release"));
    }, { once: true });
    return first.promise;
  };
  startRunner = () => { oldTask = beginPairing(scanned.code); };
  renderStrict(createElement(StartIntent));
  const currentAfterReplay = pairingWorkId();
  await act(async () => {
    next.resolve(paired);
    await oldTask;
    await newTask;
  });
  expect(handshakeCalls).toBe(2);
  expect(oldAborted).toBeTrue();
  expect(currentAfterReplay).toBe(newGeneration);
  expect(persisted.length).toBe(1);
  expect(resumeCalls).toBe(1);
  expect(phase()).not.toBe("pairing");
});

test("ordinary same-instance StrictMode replay with no intervening intent restores the released generation", async () => {
  const first = deferred<unknown>();
  let oldTask: Promise<void> | undefined;
  let capturedWork: number | undefined;
  pairCall = () => {
    if (capturedWork === undefined) capturedWork = pairingWorkId();
    return first.promise;
  };
  startRunner = () => { oldTask = beginPairing(scanned.code); };
  renderStrict(createElement(StartIntent));
  // No new intent was claimed during the release window: the replayed instance
  // must be restored to the released attempt's generation so it can land.
  expect(pairingWorkId()).toBe(capturedWork);
  await act(async () => {
    first.resolve(paired);
    await oldTask;
  });
  expect(persisted.length).toBe(1);
  expect(resumeCalls).toBe(1);
  expect(phase()).not.toBe("pairing");
});