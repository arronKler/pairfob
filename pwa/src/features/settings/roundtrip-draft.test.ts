import { afterEach, beforeEach, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { batch } from "../../shared/model/domain-store";
import { attachLiveSession, computersStore, setCredential, setLastUsedDaemon } from "../computers/catalog-store";
import { phase, setPhase, type Phase } from "../connection/connection-store";
import { currentScreen, setScreen, type Screen } from "../../app/navigation-store";
import { openPaneId, selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { composeDraft, composeStore, setComposeDraft, setComposeLive } from "../session/compose-store";
import { applyRuntimeIdentity, runtimeIdentity } from "../connection/runtime-store";
import { resetComposeDrafts } from "../../features/session/drafts/compose-drafts";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../connection/controller";
import type { PairResult } from "../../lib/protocol/client";
import type { LiveSession } from "../../lib/protocol/session-types";

/**
 * Desktop guided draft survives a settings/computers round trip (R4 regression).
 *
 * Leaving the open pane must park the visible guided draft *before* navigation;
 * returning reapplies the parked text. An entry that only performs the return
 * ceremony (bump + rebind + reapply) comes back to an empty field because the
 * entry never captured the draft.
 */

const { openSettings, leaveSettings } = await import("./actions");
const { openComputers, leaveComputers } = await import("../computers/actions");

const credential = {
  daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "device", label: "test",
  relayOrigin: "https://pairfob.com", createdAt: 1, fp: "fp",
  psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
};

const originalFetch = globalThis.fetch;

/**
 * Foreign preimages of the fields the round trip actually mutates, captured
 * before this suite's own seeds overwrite them so afterEach restores the exact
 * pre-case baseline through named owner actions (no store.reset, and no default
 * resets for fields the case never wrote — e.g. pane text/mode or device list).
 */
const checkpoint = {
  paneId: "",
  composeDraft: "",
  credential: null as PairResult | null,
  lastUsed: null as string | null,
  live: null as unknown as LiveSession | null,
  phase: "boot" as Phase,
  screen: "home" as Screen,
  runtime: { herdHost: "", runtimeKind: "" },
};

beforeEach(async () => {
  checkpoint.paneId = openPaneId();
  checkpoint.composeDraft = composeStore.get().composeDraft;
  checkpoint.credential = computersStore.get().credential;
  checkpoint.lastUsed = computersStore.get().lastUsedDaemonId;
  checkpoint.live = computersStore.get().live;
  checkpoint.phase = phase();
  checkpoint.screen = currentScreen();
  checkpoint.runtime = runtimeIdentity();
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 1200, height: 900 });
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  globalThis.fetch = (async () => new Response("2.0.0")) as typeof fetch;
  resetComposeDrafts();
  resetTransitionState();
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      setFullTerminal(false);
      setAgentChat(false);
      setComposeLive(false);
      setComposeDraft("");
      setCredential(credential as never);
      attachLiveSession({
        isConnected: () => true,
        listDevices: async () => ({ devices: [] }),
        getConfig: async () => ({ capabilities: {} }),
        agentQuota: async () => [],
      } as never);
      applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    });
  });
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
  });
  globalThis.fetch = originalFetch;
  // Original named draft/transition cleanup (the case parks drafts on the way
  // out and bumps the view transition).
  resetComposeDrafts();
  resetTransitionState();
  act(() => {
    // Restore the foreign preimages of the owners the round trip mutates,
    // through named owner actions. The removed store.reset calls only dropped
    // subscriber registries and never the records, so external subscriptions
    // stay intact; fields the case never wrote (pane text/modes, device list)
    // are left untouched.
    selectPane(checkpoint.paneId);
    setComposeDraft(checkpoint.composeDraft);
    setCredential(checkpoint.credential);
    setLastUsedDaemon(checkpoint.lastUsed);
    attachLiveSession(checkpoint.live);
    setPhase(checkpoint.phase);
    setScreen(checkpoint.screen);
    applyRuntimeIdentity(checkpoint.runtime);
  });
});

for (const route of ["settings", "computers"] as const) {
  test(`desktop guided draft is preserved across the ${route} round trip`, async () => {
    act(() => setComposeDraft("retain draft A"));
    expect(composeDraft()).toBe("retain draft A");

    await act(async () => {
      if (route === "settings") openSettings();
      else openComputers();
    });
    expect(currentScreen()).toBe(route);
    // Leaving the pane parked the draft instead of dropping it.
    expect(composeDraft()).toBe("retain draft A");

    await act(async () => {
      if (route === "settings") leaveSettings();
      else leaveComputers("pane");
    });
    expect(currentScreen()).toBe("pane");
    // The reapplied parked draft is back in the canonical composer.
    expect(composeDraft()).toBe("retain draft A");
  });
}
