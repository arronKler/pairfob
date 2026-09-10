import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { batch } from "../../shared/model/domain-store";
import { attachLiveSession, setCredential, setLastUsedDaemon } from "../computers/catalog-store";
import { stopPolling } from "../connection/controller";

/**
 * Daemon-update requesting preflight (R2 regression).
 *
 * Setting the requesting flag notifies the daemon-update subscribers. A
 * subscriber can replace the live session/credential or flag the build
 * incompatible. The captured attempt must revalidate owner and eligibility
 * immediately before the mutation and dispatch exactly zero RPCs then; an
 * ordinary update still dispatches exactly one, and a cancelled-before-dispatch
 * attempt releases only its own requesting flag.
 */

const {
  acceptDaemonVersion, checkDaemonRelease, daemonVersion, markDaemonConfigIncompatible,
  needsDaemonUpdate, refreshDaemonUpdate, startDaemonUpdate, subscribeDaemonUpdates,
} = await import("./daemon-update");

const credential = (id: string) => ({
  daemonId: id, deviceId: "device", label: "test", relayOrigin: "https://pairfob.com",
  createdAt: 1, fp: "fp", psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
});

let serial = 0;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  globalThis.fetch = (async () => new Response("2.0.0")) as typeof fetch;
  batch(() => {
    setCredential(null);
    attachLiveSession(null);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  stopPolling();
  // Restore the value this suite actually mutates — the seeded credential and
  // live session — and the side effect setCredential leaves on
  // lastUsedDaemonId. The removed store.reset calls only dropped subscriber
  // registries; the connection/navigation/pairing/runtime records are never
  // written here, so their registries stay and external subscriptions are
  // retained.
  setCredential(null);
  setLastUsedDaemon(null);
  attachLiveSession(null);
});

async function prepareUpdate(): Promise<{ getCalls: () => number }> {
  const id = `d_review_${++serial}`;
  let calls = 0;
  const status = { available: true, phase: "idle", target: "", operation_id: "" };
  const resource = {
    isConnected: () => true,
    daemonUpdateStatus: async () => status,
    daemonUpdate: async () => {
      calls += 1;
      return { ...status, phase: "downloading", target: "2.0.0" };
    },
  };
  setCredential(credential(id) as never);
  attachLiveSession(resource as never);
  acceptDaemonVersion({ build: "1.0.0" });
  await checkDaemonRelease();
  await refreshDaemonUpdate();
  expect(needsDaemonUpdate()).toBeTrue();
  return { getCalls: () => calls };
}

for (const change of ["none", "owner", "incompatible"] as const) {
  test(`daemon update ${change === "none" ? "dispatches exactly one RPC" : "retired at requesting publication dispatches none"}`, async () => {
    const prepared = await prepareUpdate();
    const view = daemonVersion()!;

    let fired = false;
    const unsubscribe = subscribeDaemonUpdates(() => {
      if (fired || !daemonVersion()?.requesting) return;
      fired = true;
      if (change === "owner") {
        attachLiveSession({ isConnected: () => true } as never);
        setCredential(credential("B") as never);
      } else if (change === "incompatible") {
        markDaemonConfigIncompatible();
      }
    });

    await startDaemonUpdate();
    unsubscribe();
    expect(fired).toBeTrue();
    expect(prepared.getCalls()).toBe(change === "none" ? 1 : 0);
    expect(view.requesting).toBeFalse();
  });
}
