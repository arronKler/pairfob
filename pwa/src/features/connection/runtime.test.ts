import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { LiveSession } from "../../lib/protocol/session-types";
import { ProtocolError } from "../../lib/protocol/client";
import { capabilitiesStore, capabilityEnabled, clearCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { applyRuntimeIdentity, resetRuntime, runtimeStore } from "./runtime-store";
import { resetGenerationsForTests } from "./generations";
import { beginIdentityRead, cancelIdentityRetry, endIdentityRead, IDENTITY_READ_GRACE_MS, refreshHerdConfig, type RuntimeObservationPorts } from "./runtime";

function legalConfig(): Record<string, unknown> {
  const capabilities: Record<string, boolean> = {};
  for (const key of [
    "create_conversation", "create_tab", "split_pane", "prompt_agent", "history",
    "list_worktrees", "create_worktree", "open_worktree", "resize_pane", "swap_pane", "zoom_pane",
  ]) capabilities[key] = false;
  capabilities.create_tab = true;
  return {
    protocol: 1,
    build: "v1.0.0",
    daemon_id: "d_aaaaaaaaaaaaaaaaaaaa",
    hostname: "herdbox",
    runtime: "herdr",
    vapid_public: "",
    submit_keys: ["Enter"],
    idle_pause_ms: 5000,
    push_delivery: "webpush",
    push_enabled: true,
    capabilities,
    agent_kinds: ["codex"],
  };
}

/** Capture scheduled timers so a retry can be fired by the test, not by the clock. */
function captureTimeouts() {
  const realSetTimeout = globalThis.setTimeout;
  const captured: Array<{ delay: number; run: () => void }> = [];
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    captured.push({ delay: delay ?? 0, run });
    return captured.length;
  }) as unknown as typeof setTimeout;
  return {
    delays: () => captured.map((entry) => entry.delay),
    take(delay: number): (() => void) | null {
      const index = captured.findIndex((entry) => entry.delay === delay);
      if (index < 0) return null;
      return captured.splice(index, 1)[0].run;
    },
    restore(): void { globalThis.setTimeout = realSetTimeout; },
  };
}

function portsFor(live: () => LiveSession | null): RuntimeObservationPorts {
  return {
    acceptDaemonVersion: () => undefined,
    markDaemonConfigIncompatible: () => undefined,
    saveCredential: async () => undefined,
    reloadComputers: async () => undefined,
    refreshFromSession: async () => undefined,
    commitView: () => undefined,
    currentLive: live,
    currentCredential: () => null,
  };
}

afterEach(() => {
  cancelIdentityRetry();
  endIdentityRead();
  clearCapabilities();
  applyRuntimeIdentity({ herdHost: "", runtimeKind: "" });
  setOperationBusy(false);
  resetGenerationsForTests();
});

describe("runtime observation ownership", () => {
  test("a subscriber retiring the live session during publication cannot restore grants", async () => {
    let live: LiveSession | null = { isConnected: () => true, getConfig: async () => legalConfig() } as unknown as LiveSession;
    let refreshRan = false;
    const ports = portsFor(() => live);
    ports.refreshFromSession = async () => {
      refreshRan = true;
    };
    const stop = runtimeStore.subscribe(() => {
      if (runtimeStore.get().runtimeKind === "herdr" && live) {
        // The retirement runs on the accepted observation itself, the same
        // domains clearLiveConnection retires.
        live = null;
        clearCapabilities();
        resetRuntime();
      }
    });
    const updated = await refreshHerdConfig(ports);
    stop();
    // Old grants must not be re-applied after the retirement.
    expect(capabilityEnabled("create_tab")).toBe(false);
    expect(runtimeStore.get().pushEnabled).not.toBe(true);
    expect(runtimeStore.get().runtimeKind).toBe("");
    // The follow-up screen reads must not run for the retired owner.
    expect(updated).toBe(false);
    expect(refreshRan).toBe(false);
  });

  test("the accepted observation publishes as one coherent update", async () => {
    const live: LiveSession | null = { isConnected: () => true, getConfig: async () => legalConfig() } as unknown as LiveSession;
    const ports = portsFor(() => live);
    const observed: Array<{ push: boolean | null; createTab: boolean }> = [];
    const stops = [runtimeStore, capabilitiesStore].map((store) =>
      store.subscribe(() => {
        // The accepted identity is the boundary that must never wear mixed grants.
        if (runtimeStore.get().runtimeKind !== "herdr") return;
        observed.push({
          push: runtimeStore.get().pushEnabled,
          createTab: capabilityEnabled("create_tab"),
        });
      }),
    );
    await refreshHerdConfig(ports);
    for (const stop of stops) stop();
    // Every published snapshot wearing the accepted identity is coherent:
    // push and capabilities arrive together, never old grants with new identity.
    expect(observed.length).toBeGreaterThan(0);
    for (const snapshot of observed) {
      expect(snapshot.push).toBe(snapshot.createTab);
    }
    expect(runtimeStore.get().runtimeKind).toBe("herdr");
    expect(capabilityEnabled("create_tab")).toBe(true);
    expect(runtimeStore.get().pushEnabled).toBe(true);
  });

  test("a stale GetConfig reply never publishes anything", async () => {
    let release!: (config: Record<string, unknown>) => void;
    let live: LiveSession | null = {
      isConnected: () => true,
      getConfig: () => new Promise<Record<string, unknown>>((resolve) => {
        release = resolve;
      }),
    } as unknown as LiveSession;
    const ports = portsFor(() => live);
    const firstDone = refreshHerdConfig(ports);
    live = { isConnected: () => true, getConfig: async () => legalConfig() } as unknown as LiveSession;
    await refreshHerdConfig(ports);
    release(legalConfig());
    await firstDone;
    expect(capabilityEnabled("create_tab")).toBe(true);
    expect(runtimeStore.get().runtimeKind).toBe("herdr");
  });
});

describe("the first runtime read", () => {
  test("an unread identity is pending until GetConfig answers", async () => {
    let answer!: (config: Record<string, unknown>) => void;
    const live = { isConnected: () => true, getConfig: () => new Promise((resolve) => { answer = resolve; }) } as unknown as LiveSession;
    const read = refreshHerdConfig(portsFor(() => live));
    expect(runtimeStore.get().identityPending).toBe(true);
    answer(legalConfig());
    await read;
    expect(runtimeStore.get().identityPending).toBe(false);
    expect(runtimeStore.get().runtimeKind).toBe("herdr");
  });

  test("a failed read is an answer too: pending ends and the identity stays empty", async () => {
    const live = { isConnected: () => true, getConfig: async () => { throw new Error("boom"); } } as unknown as LiveSession;
    await refreshHerdConfig(portsFor(() => live));
    expect(runtimeStore.get().identityPending).toBe(false);
    expect(runtimeStore.get().runtimeKind).toBe("");
  });

  test("a read that did not answer is not a verdict and is asked again", async () => {
    const calls: string[] = [];
    const live = {
      isConnected: () => true,
      getConfig: async () => {
        calls.push("timeout");
        throw new ProtocolError("timeout", "GetConfig 未回答");
      },
    } as unknown as LiveSession;
    const timers = captureTimeouts();
    try {
      const updated = await refreshHerdConfig(portsFor(() => live));
      expect(updated).toBe(false);
      expect(calls).toEqual(["timeout"]);
      expect(runtimeStore.get().identityPending).toBe(true);
      expect(runtimeStore.get().runtimeKind).toBe("");
      // The screen keeps reading, and the observation is asked again rather
      // than claiming Herdr cannot be confirmed.
      expect(timers.delays()).toContain(1_000);
    } finally {
      timers.restore();
    }
  });

  test("a known identity survives a read that did not answer", async () => {
    applyRuntimeIdentity({ herdHost: "herdbox", runtimeKind: "herdr" });
    const live = {
      isConnected: () => true,
      getConfig: async () => { throw new ProtocolError("timeout", "GetConfig 未回答"); },
    } as unknown as LiveSession;
    const timers = captureTimeouts();
    try {
      await refreshHerdConfig(portsFor(() => live));
      expect(runtimeStore.get().herdHost).toBe("herdbox");
      expect(runtimeStore.get().runtimeKind).toBe("herdr");
      expect(runtimeStore.get().identityPending).toBe(false);
    } finally {
      timers.restore();
    }
  });

  test("the scheduled retry publishes an identity the first read could not get", async () => {
    let attempts = 0;
    const live = {
      isConnected: () => true,
      getConfig: async () => {
        attempts += 1;
        if (attempts === 1) throw new ProtocolError("timeout", "GetConfig 未回答");
        return legalConfig();
      },
    } as unknown as LiveSession;
    const timers = captureTimeouts();
    try {
      await refreshHerdConfig(portsFor(() => live));
      expect(runtimeStore.get().identityPending).toBe(true);
      const retry = timers.take(1_000);
      timers.restore();
      expect(retry).not.toBeNull();
      retry!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attempts).toBe(2);
      expect(runtimeStore.get().identityPending).toBe(false);
      expect(runtimeStore.get().runtimeKind).toBe("herdr");
    } finally {
      timers.restore();
    }
  });

  test("a known identity is not re-marked pending by a foreground re-read", async () => {
    applyRuntimeIdentity({ herdHost: "herdbox", runtimeKind: "herdr" });
    let pendingSeen = false;
    const stop = runtimeStore.subscribe(() => { pendingSeen ||= runtimeStore.get().identityPending; });
    const live = { isConnected: () => true, getConfig: async () => legalConfig() } as unknown as LiveSession;
    await refreshHerdConfig(portsFor(() => live));
    stop();
    expect(pendingSeen).toBe(false);
  });

  test("an unanswered read stops counting as pending after the grace period", () => {
    const realSetTimeout = globalThis.setTimeout;
    let fire: (() => void) | null = null;
    let delay = 0;
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      fire = callback;
      delay = ms;
      return 1;
    }) as unknown as typeof setTimeout;
    try {
      beginIdentityRead();
      expect(runtimeStore.get().identityPending).toBe(true);
      expect(delay).toBe(IDENTITY_READ_GRACE_MS);
      fire!();
      expect(runtimeStore.get().identityPending).toBe(false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
