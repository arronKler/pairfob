import { afterEach, describe, expect, test } from "bun:test";
import type { LiveSession } from "../../lib/protocol/client";
import { attachLiveSession } from "../computers/catalog-store";
import { setNetworkOnline } from "./connection-store";
import { applyRuntimeIdentity, resetRuntime, runtimeStore } from "./runtime-store";
import { currentHerdStatusInput } from "./runtime-status";

afterEach(() => {
  attachLiveSession(null);
  setNetworkOnline(true);
  resetRuntime();
});

describe("runtime status adapter", () => {
  test("action-time reads see a newer identity while the published projection still holds the old one", () => {
    applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
    attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
    setNetworkOnline(true);

    // The projection a React/snapshot reader received for the last published
    // runtime frame.
    const published = runtimeStore.get();

    // A newer identity the daemon reported lands through the named runtime
    // action: the canonical live record (what action-time readers see) advances
    // immediately. To reproduce the window the bridge-era staged write created
    // (live record new, published snapshot still old until the next commit),
    // the published reader is pinned to the captured projection for the scope
    // of this test and restored in finally. No production API or state bag.
    applyRuntimeIdentity({ herdHost: "Studio", runtimeKind: "offline" });
    const originalGet = runtimeStore.get;
    runtimeStore.get = () => published;
    try {
      // The stale published projection must not be what an action-time caller sees.
      expect(runtimeStore.get().herdHost).toBe("MacBook Pro");
      expect(runtimeStore.get().runtimeKind).toBe("herdr");

      const input = currentHerdStatusInput();
      expect(input.herdHost).toBe("Studio");
      expect(input.runtimeKind).toBe("offline");
      expect(input.connected).toBeTrue();
      expect(input.networkOnline).toBeTrue();
    } finally {
      runtimeStore.get = originalGet;
    }
  });
});
