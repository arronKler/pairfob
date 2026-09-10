import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession, PairResult } from "../../lib/protocol/client";

const { applyCapabilities, capabilitiesStore, capabilityEnabled, clearCapabilities, setOperationBusy } =
  await import("../../features/operations/capabilities-store");
const { applyDeviceList, beginSettingsRead, endSettingsRead, resetRuntime, runtimeStore, settingsRequestIsCurrent } =
  await import("../../features/connection/runtime-store");
const { captureNoticeScope, clearNotice, showStatus, visibleNotice } = await import("../notices-store");
const { selectPane } = await import("../../features/session/session-store");
const { applyTrace, chatStore, resetTrace } = await import("../../features/session/chat/trace-store");
const { replaceAgentsFromSnapshot, resetDashboard, selectedAgent } = await import("../../features/dashboard/catalog-store");
const { attachLiveSession, computers, computersStore, credential: currentCredential, liveSession, setComputers, setCredential } = await import("../../features/computers/catalog-store");
const { adoptDaemonPreferences, preferencesStore, setPaneTermMode } = await import("../../features/settings/preferences-store");

function credential(daemonId: string, label = "Computer"): PairResult {
  return {
    daemonId, deviceId: `dev_${daemonId}`, psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
    relayOrigin: "https://pairfob.com", fp: "fp_test", label, createdAt: 1,
  };
}

const DAEMON_A = "d_aaaaaaaaaaaaaaaaaaaa";
const DAEMON_B = "d_bbbbbbbbbbbbbbbbbbbb";
const restore = { credential: currentCredential(), computers: computers(), live: liveSession() };

afterEach(() => {
  clearCapabilities();
  setOperationBusy(false);
  resetRuntime();
  setCredential(restore.credential);
  setComputers(restore.computers);
  attachLiveSession(restore.live);
  adoptDaemonPreferences();
  for (const key of ["paneTermMode", "paneComposeLive", "panePinned", "paneTouched"]) {
    localStorage.removeItem(`pairfob:${key}:${DAEMON_A}`);
    localStorage.removeItem(`pairfob:${key}:${DAEMON_B}`);
  }
});

describe("adopted input is owned, not aliased", () => {
  test("a caller keeping the grants it passed cannot change what is authorized", () => {
    const capabilities = { ...NO_OPERATION_CAPABILITIES, delete_file: false };
    const agentKinds = ["codex"];
    applyCapabilities(capabilities, agentKinds);

    let publishes = 0;
    const release = capabilitiesStore.subscribe(() => { publishes += 1; });
    capabilities.delete_file = true;
    agentKinds.push("injected");

    expect(capabilityEnabled("delete_file")).toBeFalse();
    expect(capabilitiesStore.get().operationCapabilities.delete_file).toBeFalse();
    expect(capabilitiesStore.get().agentKinds).toEqual(["codex"]);
    expect(publishes).toBe(0);

    // An unrelated action must not hitchhike the externally changed grant in.
    setOperationBusy(true);
    expect(capabilityEnabled("delete_file")).toBeFalse();
    expect(capabilitiesStore.get().agentKinds).toEqual(["codex"]);
    expect(publishes).toBe(1);
    setOperationBusy(false);
    release();
  });

  test("adopted device rows and catalog entries are detached from their callers", () => {
    const devices = [{ deviceId: "dev_a", label: "Phone", current: true } as never];
    applyDeviceList(devices);
    (devices[0] as { label: string }).label = "Renamed";
    devices.push({ deviceId: "dev_b" } as never);
    expect(runtimeStore.get().deviceList.map((device) => device.label)).toEqual(["Phone"]);
    expect(runtimeStore.get().deviceList.length).toBe(1);

    const catalog = [credential(DAEMON_A, "Studio")];
    setComputers(catalog);
    catalog[0]!.label = "Renamed";
    catalog.push(credential(DAEMON_B));
    expect(computersStore.get().computers.length).toBe(1);
    expect(computersStore.get().computers[0]?.label).toBe("Studio");
    expect(computers().length).toBe(1);
  });
});

describe("opaque handles keep their identity", () => {
  test("a plain-object session handle is shared, callable and never frozen", () => {
    const live = {
      calls: [] as string[],
      isConnected(): boolean { return true; },
      note(label: string): void { this.calls.push(label); },
    };
    attachLiveSession(live as unknown as LiveSession);

    expect(liveSession()).toBe(live as unknown as LiveSession);
    expect(computersStore.get().live).toBe(live as unknown as LiveSession);
    expect(Object.isFrozen(computersStore.get().live)).toBeFalse();

    // A method that writes through its receiver works when called on the snapshot.
    (computersStore.get().live as unknown as typeof live).note("through-snapshot");
    expect(live.calls).toEqual(["through-snapshot"]);
    expect((computersStore.get().live as unknown as typeof live).isConnected()).toBeTrue();
  });

  test("an adopted credential is owned data: detached, with key material shared", () => {
    const pair = credential(DAEMON_A);
    setCredential(pair);
    expect(computersStore.get().credential).not.toBe(pair);
    expect(computersStore.get().credential?.daemonId).toBe(DAEMON_A);
    // The key material is a foreign handle: shared, never cloned or frozen.
    expect(computersStore.get().credential?.psk).toBe(pair.psk);
    expect(Object.isFrozen(computersStore.get().credential?.psk)).toBeFalse();

    pair.label = "Renamed later";
    expect(computersStore.get().credential?.label).toBe("Computer");
    expect(currentCredential()?.label).toBe("Computer");
  });
});

describe("published views are detached", () => {
  test("the selected card and the previous cards are views, not the domain's data", () => {
    resetDashboard();
    const previous = replaceAgentsFromSnapshot({
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "claude", agent_status: "working" }],
    });
    selectPane("p1");
    const card = selectedAgent();
    expect(card?.paneId).toBe("p1");
    card!.cwd = "/edited";
    card!.hasAgent = false;
    expect(selectedAgent()?.hasAgent).toBeTrue();
    expect(selectedAgent()?.cwd).not.toBe("/edited");

    previous.push({ paneId: "injected" } as never);
    const next = replaceAgentsFromSnapshot({ panes: [] });
    expect(next.map((item) => item.paneId)).toEqual(["p1"]);
    resetDashboard();
  });

  test("a notice and its scope are adopted frozen, so a caller cannot relocate it", () => {
    selectPane("p1");
    const scope = { ...captureNoticeScope(), paneId: "p1" };
    showStatus("已发送", true, scope);
    const shown = visibleNotice();
    expect(shown?.text).toBe("已发送");
    expect(Object.isFrozen(shown)).toBeTrue();
    expect(Object.isFrozen(shown?.scope)).toBeTrue();
    // The caller keeps its object; editing it must not move the notice's scope.
    scope.paneId = "p2";
    expect(visibleNotice()?.scope?.paneId).toBe("p1");
    expect(visibleNotice()).toBe(shown);
    selectPane("p1");
    expect(visibleNotice()?.text).toBe("已发送");
    selectPane("p2");
    expect(visibleNotice()).toBeNull();
    clearNotice();
  });

  test("a transcript patch is detached, and no callback sees the live record", () => {
    const items = [{ id: "t1" } as never];
    applyTrace({ agentTraceItems: items, agentTraceLoadState: "ready" });
    items.push({ id: "injected" } as never);
    // Original oracle timing: the published snapshot is length 1 immediately
    // after the caller's push.
    expect(chatStore.get().agentTraceItems.length).toBe(1);
    // Republish through a legitimate unrelated field write: a no-detach mutation
    // that kept the caller array would carry the injected row into the canonical
    // record and surface here as length 2. Proper detachment keeps it at 1 even
    // through an ordinary republish (this is the canonical-poison oracle).
    applyTrace({ agentTraceTail: 1 });
    expect(chatStore.get().agentTraceItems.length).toBe(1);
    expect(chatStore.get().agentTraceTail).toBe(1);
    resetTrace();
    expect(chatStore.get().agentTraceLoadState).toBe("cold");
  });
});

describe("publication ordering", () => {
  test("a reentrant settings read gets its own token and the older one retires", () => {
    resetRuntime();
    let inner = -1;
    let reentered = false;
    const release = runtimeStore.subscribe(() => {
      if (reentered) return;
      reentered = true;
      inner = beginSettingsRead();
    });

    const outer = beginSettingsRead();
    release();

    expect(inner).not.toBe(outer);
    expect(settingsRequestIsCurrent(inner)).toBeTrue();
    expect(settingsRequestIsCurrent(outer)).toBeFalse();

    // A retired request cannot clear the newer read's loading state.
    endSettingsRead(outer);
    expect(runtimeStore.get().settingsLoading).toBeTrue();
    endSettingsRead(inner);
    expect(runtimeStore.get().settingsLoading).toBeFalse();
  });

  test("a pane preference is stored before a subscriber can switch computers", () => {
    localStorage.setItem(`pairfob:paneTermMode:${DAEMON_A}`, '{"p1":"guided"}');
    localStorage.setItem(`pairfob:paneTermMode:${DAEMON_B}`, '{"p1":"agent"}');
    setCredential(credential(DAEMON_A));
    adoptDaemonPreferences();
    expect(preferencesStore.get().paneTermModes).toEqual({ p1: "guided" });

    let switched = false;
    const release = preferencesStore.subscribe(() => {
      if (switched) return;
      switched = true;
      setCredential(credential(DAEMON_B));
      adoptDaemonPreferences();
    });

    setPaneTermMode("p1", "full");
    release();

    // The explicit choice lands under the computer that was connected when it was
    // made, and the computer the subscriber switched to keeps its own map.
    expect(localStorage.getItem(`pairfob:paneTermMode:${DAEMON_A}`)).toBe('{"p1":"full"}');
    expect(localStorage.getItem(`pairfob:paneTermMode:${DAEMON_B}`)).toBe('{"p1":"agent"}');
    expect(preferencesStore.get().paneTermModes).toEqual({ p1: "agent" });
  });

  test("every daemon-scoped save in one action lands under one computer", () => {
    localStorage.setItem(`pairfob:paneTermMode:${DAEMON_A}`, '{"p1":"guided"}');
    localStorage.setItem(`pairfob:paneTermMode:${DAEMON_B}`, '{"p1":"agent"}');
    setCredential(credential(DAEMON_A));
    adoptDaemonPreferences();
    setPaneTermMode("p1", "full");
    setPaneTermMode("p2", "agent");
    expect(preferencesStore.get().paneTermModes).toEqual({ p1: "full", p2: "agent" });
    expect(JSON.parse(localStorage.getItem(`pairfob:paneTermMode:${DAEMON_A}`) || "{}"))
      .toEqual({ p1: "full", p2: "agent" });
    expect(localStorage.getItem(`pairfob:paneTermMode:${DAEMON_B}`)).toBe('{"p1":"agent"}');
  });
});
