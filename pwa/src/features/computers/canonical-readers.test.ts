import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import { batch } from "../../shared/model/domain-store";
import type { PairResult, LiveSession } from "../../lib/protocol/client";
import {
  attachLiveSession, computers, computersStore, credential, setAddingComputer, setComputers,
  setCredential, setLastUsedDaemon,
} from "./catalog-store";
import {
  applyPairingFragment, capturePairingFragment, clearNotificationTarget, clearPairingFragment,
  connectionStore, notificationTarget, pairingFragment,
} from "../connection/connection-store";
import { pairCodeDraft, setPairCodeDraft } from "../pairing/form-store";

/**
 * Canonical computers()/credential() readers.
 *
 * These two readers are the boot decision's action-time view of the canonical
 * catalog and credential. Regression: they used to return the owner controller's
 * live mutable records, so an alias obtained from the reader could write POISON
 * straight into the canonical record without any notification, and the next
 * ordinary publication would republish the poisoned identity. They must hand out
 * detached, frozen plain metadata re-read at action time — never a writable
 * alias of the canonical record and never a stale published snapshot.
 */

function pair(daemonId: string): PairResult {
  return {
    daemonId, deviceId: "phone", psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
    relayOrigin: "https://pairfob.com", fp: "fp", label: "Owned", createdAt: 1,
  };
}

/**
 * Foreign preimages of every field this suite writes, captured before its own
 * seeds so afterEach restores the exact pre-case baseline through named owner
 * actions — never defaults, and never a subscriber wipe (the removed
 * store.reset calls only dropped registries). The original fixture captured
 * the same records through the legacy state facade; this keeps that contract
 * on the real owner reads.
 */
const previous = {
  computers: null as readonly PairResult[] | null,
  credential: null as PairResult | null,
  live: null as unknown as LiveSession | null,
  addingComputer: false,
  lastUsedDaemonId: null as string | null,
};

beforeEach(() => {
  previous.computers = computersStore.get().computers;
  previous.credential = computersStore.get().credential;
  previous.live = computersStore.get().live;
  previous.addingComputer = computersStore.get().addingComputer;
  previous.lastUsedDaemonId = computersStore.get().lastUsedDaemonId;
  setComputers([]);
  setCredential(null);
  setAddingComputer(false);
});

afterEach(() => {
  // Restore the captured foreign preimages, not defaults: setCredential also
  // rewrites lastUsedDaemonId, so the preimage of that side effect is restored
  // after it.
  setAddingComputer(previous.addingComputer);
  setComputers(previous.computers ?? []);
  setCredential(previous.credential);
  setLastUsedDaemon(previous.lastUsedDaemonId);
  attachLiveSession(previous.live);
});

describe("canonical readers do not leak owned metadata", () => {
  for (const kind of ["catalog", "credential"] as const) {
    test(`an alias taken from ${kind}() cannot write into the canonical record`, () => {
      setComputers([pair("A")]);
      setCredential(pair("A"));
      let notifications = 0;
      const stop = computersStore.subscribe(() => { notifications += 1; });
      const published = computersStore.get();
      const alias = kind === "catalog" ? computers()[0]! : credential()!;
      try {
        alias.daemonId = "POISON";
      } catch {
        /* frozen metadata rejects the write */
      }
      const canonical = kind === "catalog" ? computers()[0]!.daemonId : credential()!.daemonId;
      // The alias mutation must never notify, and the canonical value must never
      // change; capture both before any *ordinary* publication below.
      const probe = {
        notifications,
        canonical,
        publishedComputers: published.computers[0].daemonId,
        publishedCredential: published.credential!.daemonId,
      };
      setAddingComputer(true);
      const republished = kind === "catalog"
        ? computersStore.get().computers[0]!.daemonId
        : computersStore.get().credential!.daemonId;
      stop();
      expect(probe.notifications).toBe(0);
      expect(probe.canonical).toBe("A");
      expect(probe.publishedComputers).toBe("A");
      expect(probe.publishedCredential).toBe("A");
      expect(republished).toBe("A");
    });
  }

  test("the readers hand out detached frozen plain metadata, key handles shared by identity", () => {
    const own = pair("A");
    setComputers([own]);
    setCredential(own);
    const catalog = computers();
    const cred = credential()!;
    // Detached: a fresh object each call, never the canonical record's rows.
    expect(catalog).not.toBe(computersStore.get().computers);
    expect(catalog[0]).not.toBe(computersStore.get().computers[0]);
    expect(cred).not.toBe(computersStore.get().credential);
    expect(computers()[0]).not.toBe(catalog[0]);
    // Plain identity metadata is frozen; the cryptographic key material stays a
    // shared opaque handle, exactly as the published snapshot treats it.
    expect(Object.isFrozen(catalog[0])).toBeTrue();
    expect(Object.isFrozen(cred)).toBeTrue();
    expect(Object.isFrozen(catalog[0].psk)).toBeFalse();
    expect(catalog[0].psk).toBe(own.psk);
    expect(cred.psk).toBe(own.psk);
  });

  test("named actions keep the readers and the published snapshot fresh inside a batch, then notify the observer once", () => {
    setComputers([pair("A")]);
    setCredential(pair("A"));
    // Retain the published snapshot: it is immutable, so it must keep A/A as a
    // historical value even after the newer writes publish below.
    const published = computersStore.get();
    let notifications = 0;
    let seen: { catalog: string; credential: string } | null = null;
    const stop = computersStore.subscribe(() => {
      const snapshot = computersStore.get();
      notifications += 1;
      seen = { catalog: snapshot.computers[0].daemonId, credential: snapshot.credential!.daemonId };
    });
    // The original pending-write window was produced only by the legacy facade
    // dirty write (bridgeRecord + markDirty): the catalog owner has no staged
    // composition action, so after facade retirement no named computers write
    // can hold publication. The real contract this case now guards (see
    // computers-canonical-design-review-2025) is named-action freshness while
    // notifications are batched: inside the batch the readers and the actual
    // published snapshot both already see B/C, no callback has fired, and the
    // domain holds no composition claim; after the batch one observer sees the
    // coherent B/C reader-and-snapshot tuple and the retained old snapshot
    // still reads A/A.
    batch(() => {
      setComputers([pair("B")]);
      setCredential(pair("C"));
      expect(notifications).toBe(0);
      expect(computersStore.isCompositionPending()).toBeFalse();
      expect(computersStore.get().computers[0].daemonId).toBe("B");
      expect(computersStore.get().credential!.daemonId).toBe("C");
      expect(computers()[0].daemonId).toBe("B");
      expect(credential()!.daemonId).toBe("C");
    });
    // One coherent notification after the batch, not one per write.
    expect(notifications).toBe(1);
    expect(seen).toEqual({ catalog: "B", credential: "C" });
    // The retained immutable snapshot still holds the pre-write A/A values.
    expect(published.computers[0].daemonId).toBe("A");
    expect(published.credential!.daemonId).toBe("A");
    stop();
  });
});

/**
 * Canonical pairing-fragment and notification-target readers. The scanner
 * adoption action and the deep-link capture hand plain intent data to the
 * connection domain; the readers and the adoption path must both detach it, so
 * neither the scanner keeping its result object nor a caller keeping a reader's
 * return value can mutate the next pairing/pane intent without an action.
 */
describe("canonical intent readers do not leak plain fragment/target data", () => {
  const fragment = () => ({ v: 2 as const, pairRef: "a".repeat(32), code: "01234567", daemonId: "d_aaaaaaaaaaaaaaaaaaaa" });

  // capturePairingFragment writes the pairing code draft as a side effect; keep
  // its foreign preimage and put it back through the named setter.
  let previousDraft = "";
  beforeEach(() => {
    previousDraft = pairCodeDraft();
  });

  afterEach(() => {
    clearPairingFragment();
    clearNotificationTarget();
    setPairCodeDraft(previousDraft);
  });

  test("adopting a scanner fragment detaches the caller object", () => {
    const input = fragment();
    applyPairingFragment(input);
    const published = connectionStore.get();
    let notifications = 0;
    const stop = connectionStore.subscribe(() => { notifications += 1; });
    input.code = "POISON";
    stop();
    expect(notifications).toBe(0);
    expect(connectionStore.get()).toBe(published);
    expect(pairingFragment()!.code).toBe("01234567");
  });

  test("the fragment reader returns detached frozen data that cannot redirect the intent", () => {
    applyPairingFragment(fragment());
    const published = connectionStore.get();
    try {
      pairingFragment()!.code = "POISON";
    } catch {
      /* frozen view rejects the write */
    }
    expect(connectionStore.get()).toBe(published);
    expect(pairingFragment()!.code).toBe("01234567");
    // Fresh detached copy per call: no caller-held alias into canonical data.
    expect(pairingFragment()).not.toBe(pairingFragment());
  });

  test("a captured notification target cannot be redirected through its reader", () => {
    const originalLocation = globalThis.location;
    const originalHistory = globalThis.history;
    Object.assign(globalThis, {
      location: { hash: "#notify=1&d=d_aaaaaaaaaaaaaaaaaaaa&pane=p1", pathname: "/pair", search: "" },
      history: { replaceState() {} },
    });
    try {
      capturePairingFragment();
      const published = connectionStore.get();
      expect(published.notificationTarget!.paneId).toBe("p1");
      try {
        notificationTarget()!.paneId = "p2";
      } catch {
        /* frozen view rejects the write */
      }
      expect(connectionStore.get()).toBe(published);
      expect(notificationTarget()!.paneId).toBe("p1");
    } finally {
      Object.assign(globalThis, { location: originalLocation, history: originalHistory });
    }
  });
});