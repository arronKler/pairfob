import { describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { applyCapabilities } from "./capabilities-store";
import { attachLiveSession } from "../computers/catalog-store";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/session-types";
import { runHerdOperation, type MutationRunnerPorts } from "./run";

await resetBoardTestDOM();

function ports(overrides: Partial<MutationRunnerPorts> = {}): MutationRunnerPorts & { paints: number; ran: number } {
  const live = { isConnected: () => true } as LiveSession;
  const out = {
    paints: 0,
    ran: 0,
    currentIncarnation: () => 1,
    currentViewVersion: () => 1,
    promptLockHeld: () => true,
    currentLive: () => live,
    currentDaemonId: () => null,
    busy: () => false,
    connected: () => true,
    capabilityEnabled: () => false,
    acquirePromptLock: () => 1,
    releasePromptLock: () => true,
    reconcile: async () => undefined,
    refreshFromSession: async () => undefined,
    commitView: () => {
      out.paints += 1;
    },
    ...overrides,
  };
  return out;
}

describe("operation runner", () => {
  test("an unadvertised capability is fail-closed and does not run the action", async () => {
    attachLiveSession({ isConnected: () => true } as LiveSession);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    const seen = ports({
      currentLive: () => ({ isConnected: () => true }) as LiveSession,
      capabilityEnabled: () => false,
    });
    let ran = 0;
    await runHerdOperation("pending", "ok", async () => {
      ran += 1;
    }, seen, { capability: "create_tab" });
    expect(ran).toBe(0);
    expect(seen.paints).toBe(0);
  });

  test("a dropped session after the await does not refresh", async () => {
    let live: LiveSession | null = { isConnected: () => true } as LiveSession;
    let refreshed = 0;
    const seen = ports({
      currentLive: () => live,
      currentDaemonId: () => null,
      capabilityEnabled: () => true,
      refreshFromSession: async () => {
        refreshed += 1;
      },
    });
    let ran = 0;
    await runHerdOperation("pending", "ok", async () => {
      ran += 1;
      live = null;
      return { pane_id: "p" };
    }, seen, { capability: "create_tab" });
    expect(ran).toBe(1);
    expect(refreshed).toBe(0);
  });

  test("a notice/lock subscriber that switches computer prevents the RPC", async () => {
    const first = { isConnected: () => true } as LiveSession;
    const next = { isConnected: () => true } as LiveSession;
    let live: LiveSession | null = first;
    let released = 0;
    let ran = 0;
    const seen = ports({
      currentLive: () => live,
      currentDaemonId: () => null,
      capabilityEnabled: () => true,
      acquirePromptLock: () => 7,
      releasePromptLock: () => {
        released += 1;
        return true;
      },
      commitView: () => {
        live = next;
      },
    });
    await runHerdOperation("pending", "ok", async () => {
      ran += 1;
    }, seen, { capability: "create_tab" });
    expect(ran).toBe(0);
    expect(released).toBe(1);
  });

  test("a pending-notice subscriber revoking the capability prevents the send", async () => {
    const { noticesStore } = await import("../../app/notices-store");
    let allowed = true;
    let released = 0;
    let ran = 0;
    const seen = ports({
      capabilityEnabled: () => allowed,
      acquirePromptLock: () => 7,
      releasePromptLock: () => {
        released += 1;
        return true;
      },
    });
    const stop = noticesStore.subscribe(() => {
      if (noticesStore.get().notice) allowed = false;
    });
    await runHerdOperation("pending", "ok", async () => {
      ran += 1;
    }, seen, { capability: "create_tab" });
    stop();
    // Capability revalidated at the final pre-send boundary; only this
    // operation's lock and notice were cleaned up.
    expect(ran).toBe(0);
    expect(released).toBe(1);
    expect(noticesStore.get().notice).toBeNull();
  });

  test("unknown_outcome reconciles without rerunning the action", async () => {
    const { ProtocolError } = await import("../../lib/protocol/errors.ts");
    let ran = 0;
    let reconciles = 0;
    const seen = ports({
      capabilityEnabled: () => true,
      reconcile: async () => {
        reconciles += 1;
      },
    });
    await runHerdOperation("pending", "ok", async () => {
      ran += 1;
      throw new ProtocolError("unknown_outcome", "ambiguous");
    }, seen, { capability: "create_tab" });
    expect(ran).toBe(1);
    expect(reconciles).toBe(1);
  });
});
