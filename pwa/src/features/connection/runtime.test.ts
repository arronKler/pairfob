import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { LiveSession } from "../../lib/protocol/session-types";
import { capabilitiesStore, capabilityEnabled, clearCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { applyRuntimeIdentity, resetRuntime, runtimeStore } from "./runtime-store";
import { resetGenerationsForTests } from "./generations";
import { refreshHerdConfig, type RuntimeObservationPorts } from "./runtime";

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
