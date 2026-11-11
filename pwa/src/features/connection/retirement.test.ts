import { resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardCatalog } from "../board/layout-store";
import { applyCapabilities, capabilityEnabled, clearCapabilities, operationBusy, setOperationBusy } from "../operations/capabilities-store";
import { attachLiveSession, liveSession } from "../computers/catalog-store";
import {
  networkOnline,
  noteP2PAttempt,
  noteRelayRtt,
  setSessionTransport,
  setTransportSwitching,
} from "./connection-store";
import { dashboardStore, refreshBusy, replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyRuntimeIdentity, runtimeStore, setPushEnabled } from "./runtime-store";
import { paneReadBusy, queueSnapshot, resetPaneView, selectPane, sessionStore, setFullTerminal, setPaneReadBusy, snapshotIsPending } from "../session/session-store";
import { domainStores } from "../../app/domain-publication";
import { batch } from "../../shared/model/domain-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { retireLiveDomains } from "./retirement";

const session = { isConnected: () => true } as unknown as LiveSession;

let publishes: Record<string, number> = {};
const releases: Array<() => void> = [];
/** What a subscriber sees at the moment its own domain publishes. */
let observedMidRetirement: string[] = [];

function watchAllDomains(): void {
  publishes = {};
  observedMidRetirement = [];
  for (const store of domainStores) {
    releases.push(
      store.subscribe(() => {
        publishes[store.name] = (publishes[store.name] ?? 0) + 1;
        // A listener must never catch a half-retired application: by the time any
        // domain publishes, the session handle, the capabilities and the herd are
        // already gone.
        if (liveSession() !== null) observedMidRetirement.push(`${store.name}:live`);
        if (capabilityEnabled("create_tab")) observedMidRetirement.push(`${store.name}:capability`);
        if (dashboardStore.get().agents.length) observedMidRetirement.push(`${store.name}:agents`);
      }),
    );
  }
}

function live(): void {
  attachLiveSession(session);
  applyRuntimeIdentity({ herdHost: "macbook", runtimeKind: "herdr" });
  setPushEnabled(true);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true, close_pane: true }, ["codex"]);
  setOperationBusy(true);
  noteRelayRtt(42);
  setSessionTransport("p2p");
  setTransportSwitching(true);
  noteP2PAttempt({ result: "failed", extra: "probe" } as never);
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" },
    workspaces: [{ workspace_id: "w1", label: "alpha", cwd: "/tmp/a" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/a", agent: "codex", agent_status: "working" }],
  });
  selectPane("w1:p1");
  setFullTerminal(true);
  queueSnapshot();
  setPaneReadBusy(true);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  live();
  watchAllDomains();
});

afterEach(() => {
  while (releases.length) releases.pop()!();
  attachLiveSession(null);
  resetPaneView();
  resetBoardCatalog();
  clearCapabilities();
  setOperationBusy(false);
  setTransportSwitching(false);
  setSessionTransport("relay");
});

describe("session retirement", () => {
  test("every session-scoped domain is dropped, and each publishes at most once", () => {
    batch(() => retireLiveDomains());

    expect(liveSession()).toBeNull();
    expect(runtimeStore.get().herdHost).toBe("");
    expect(runtimeStore.get().runtimeKind).toBe("");
    expect(runtimeStore.get().pushEnabled).toBeNull();
    expect(runtimeStore.get().deviceList).toEqual([]);
    expect(capabilityEnabled("create_tab")).toBe(false);
    expect(capabilityEnabled("close_pane")).toBe(false);
    expect(operationBusy()).toBe(false);
    expect(dashboardStore.get().agents).toEqual([]);
    expect(dashboardStore.get().lastHerdSig).toBe("");
    expect(refreshBusy()).toBe(false);
    expect(sessionStore.get().paneId).toBe("");
    expect(sessionStore.get().fullTerminal).toBe(false);
    expect(sessionStore.get().paneText).toBe("");
    expect(snapshotIsPending()).toBe(false);
    expect(paneReadBusy()).toBe(false);
    expect(networkOnline()).toBe(true);

    // One transaction: no domain publishes twice for a single retirement.
    for (const [domain, count] of Object.entries(publishes)) {
      expect([domain, count <= 1]).toEqual([domain, true]);
    }
    expect(publishes.computers).toBe(1);
    expect(publishes.dashboard).toBe(1);
    expect(publishes.session).toBe(1);
  });

  test("no subscriber ever observes a half-retired application", () => {
    batch(() => retireLiveDomains());
    expect(observedMidRetirement).toEqual([]);
  });

  test("retiring an already retired session is quiet and idempotent", () => {
    batch(() => retireLiveDomains());
    while (releases.length) releases.pop()!();
    watchAllDomains();
    batch(() => retireLiveDomains());
    expect(liveSession()).toBeNull();
    for (const [domain, count] of Object.entries(publishes)) {
      expect([domain, count <= 1]).toEqual([domain, true]);
    }
    expect(dashboardStore.get().agents).toEqual([]);
    expect(observedMidRetirement).toEqual([]);
  });
});
