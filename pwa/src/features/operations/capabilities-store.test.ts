import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";

const { applyCapabilities, capabilitiesStore, capabilityEnabled, clearCapabilities, operationCapabilities, setOperationBusy } =
  await import("./capabilities-store");
const { applyDeviceList, applyRuntimeIdentity, beginSettingsRead, bumpSettingsRequest, endSettingsRead, resetRuntime,
  runtimeIdentity, runtimeStore, setPushConfigError, setPushEnabled, setPushSubscribed, settingsRequestIsCurrent } =
  await import("../connection/runtime-store");

afterEach(() => {
  clearCapabilities();
  setOperationBusy(false);
  resetRuntime();
});

describe("capabilities domain", () => {
  test("advertised grants are the authority and a reset fails closed", () => {
    const granted = { ...NO_OPERATION_CAPABILITIES, create_tab: true, prompt_agent: true, rename_file: true };
    applyCapabilities(granted, ["claude", "codex"]);

    expect(capabilityEnabled("create_tab")).toBeTrue();
    expect(capabilityEnabled("prompt_agent")).toBeTrue();
    expect(capabilityEnabled("rename_file")).toBeTrue();
    // An older daemon that does not advertise a key means false, never "assume yes".
    expect(capabilityEnabled("delete_file")).toBeFalse();
    expect(capabilityEnabled("create_worktree")).toBeFalse();
    expect(capabilitiesStore.get().agentKinds).toEqual(["claude", "codex"]);
    expect(operationCapabilities().create_tab).toBeTrue();

    clearCapabilities();
    expect(capabilitiesStore.get().operationCapabilities).toEqual(NO_OPERATION_CAPABILITIES);
    expect(capabilityEnabled("create_tab")).toBeFalse();
    expect(capabilitiesStore.get().agentKinds).toEqual([]);
  });

  test("a published capability snapshot cannot be edited by a reader", () => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, split_pane: true }, []);
    const published = capabilitiesStore.get();
    expect(Object.isFrozen(published.operationCapabilities)).toBeTrue();
    expect(() => {
      (published.operationCapabilities as { split_pane: boolean }).split_pane = false;
    }).toThrow();
    expect(capabilityEnabled("split_pane")).toBeTrue();
  });

  test("new operationCapabilities read cannot change canonical grants without an action", () => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    let notifications = 0;
    const stop = capabilitiesStore.subscribe(() => { notifications += 1; });
    try {
      const grants = operationCapabilities();
      grants.split_pane = true;
      expect(capabilitiesStore.get().operationCapabilities.split_pane).toBeFalse();
      expect(notifications).toBe(0);
      expect(capabilityEnabled("split_pane")).toBeFalse();
    } finally {
      stop();
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    }
  });

  test("operationCapabilities is the live write, not a stale published snapshot", () => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    const previous = capabilitiesStore.get();
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, split_pane: true }, []);
    expect(previous.operationCapabilities.split_pane).toBeFalse();
    expect(operationCapabilities().split_pane).toBeTrue();
    expect(capabilityEnabled("split_pane")).toBeTrue();
  });

  test("one mutation in flight is one busy marker, published once", () => {
    let publishes = 0;
    const release = capabilitiesStore.subscribe(() => { publishes += 1; });
    setOperationBusy(true);
    setOperationBusy(true);
    expect(publishes).toBe(1);
    expect(capabilitiesStore.get().operationBusy).toBeTrue();
    setOperationBusy(false);
    expect(publishes).toBe(2);
    expect(capabilitiesStore.get().operationBusy).toBeFalse();
    release();
  });
});

describe("runtime domain", () => {
  test("a settings read token invalidates the answer of a dead session", () => {
    const first = beginSettingsRead();
    expect(runtimeStore.get().settingsLoading).toBeTrue();
    expect(runtimeStore.get().devicesError).toBe("");
    expect(settingsRequestIsCurrent(first)).toBeTrue();

    const second = beginSettingsRead();
    expect(settingsRequestIsCurrent(first)).toBeFalse();
    expect(second).toBe(first + 1);

    endSettingsRead(first);
    expect(runtimeStore.get().settingsLoading).toBeTrue();
    endSettingsRead(second);
    expect(runtimeStore.get().settingsLoading).toBeFalse();

    bumpSettingsRequest();
    expect(settingsRequestIsCurrent(second)).toBeFalse();
    expect(runtimeStore.get().settingsLoading).toBeFalse();
  });

  test("runtimeIdentity reads the connected daemon at action time, without a writable alias", () => {
    resetRuntime();
    expect(runtimeIdentity()).toEqual({ herdHost: "", runtimeKind: "" });

    applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
    const identity = runtimeIdentity();
    expect(identity).toEqual({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
    expect(Object.isFrozen(identity)).toBeTrue();
    // A fresh pair of strings, not the record and not the published snapshot.
    expect(runtimeIdentity()).not.toBe(identity);
    expect(runtimeIdentity()).toEqual(identity);

    // The runtime domain has no staged composition path, so the real owner
    // action publishes immediately: the canonical reader and the published
    // snapshot agree on the newer identity, while the previously published
    // snapshot object keeps the old value (immutable historical snapshot).
    const beforeWrite = runtimeStore.get();
    applyRuntimeIdentity({ herdHost: "Studio", runtimeKind: "herdr" });
    expect(runtimeIdentity().herdHost).toBe("Studio");
    expect(beforeWrite.herdHost).toBe("MacBook Pro");
    expect(runtimeStore.get().herdHost).toBe("Studio");

    resetRuntime();
    expect(runtimeIdentity()).toEqual({ herdHost: "", runtimeKind: "" });
  });

  test("daemon-reported identity, devices and push state stay in the runtime domain", () => {
    applyRuntimeIdentity({ herdHost: "MacBook Pro", runtimeKind: "herdr" });
    applyDeviceList([{ deviceId: "dev_a", label: "Phone", current: true } as never], "");
    setPushEnabled(true);
    setPushSubscribed(false);

    expect(runtimeStore.get().herdHost).toBe("MacBook Pro");
    expect(runtimeStore.get().runtimeKind).toBe("herdr");
    expect(runtimeStore.get().deviceList.map((device) => device.deviceId)).toEqual(["dev_a"]);
    expect(runtimeStore.get().pushEnabled).toBeTrue();
    expect(runtimeStore.get().pushSubscribed).toBeFalse();

    setPushConfigError("推送状态读取失败");
    expect(runtimeStore.get().pushConfigError).toBe("推送状态读取失败");

    resetRuntime();
    expect(runtimeStore.get()).toEqual({
      herdHost: "", runtimeKind: "", deviceList: [], pushEnabled: null, pushSubscribed: null,
      settingsLoading: false, devicesError: "", pushConfigError: "",
      settingsRequest: runtimeStore.get().settingsRequest,
    });
  });
});
