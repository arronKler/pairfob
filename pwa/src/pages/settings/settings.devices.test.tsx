import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { applyDeviceList, resetRuntime, runtimeStore } from "../../features/connection/runtime-store";
import { applyOriginConfig, connectionStore, setPhase, type Phase } from "../../features/connection/connection-store";
import { attachLiveSession, computersStore, setCredential, setLastUsedDaemon } from "../../features/computers/catalog-store";
import { navigationStore, setScreen, type Screen } from "../../app/navigation-store";
import { clearNotice, noticesStore, showError, showStatus, visibleNotice, type Notice } from "../../app/notices-store";
import { t, setLang } from "../../lib/i18n";
import type { DeviceSummary, PairResult } from "../../lib/protocol/client";
import type { LiveSession } from "../../lib/protocol/session-types";
import { stopPolling } from "../../features/connection/controller";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { revokeDevice } from "../../features/operations/controller";

/**
 * Settings paired-devices panel against the actual mounted App. Setup writes
 * the credential, device list and session through named typed actions; the
 * forget flow runs through the real revokeDevice controller (confirm dialog,
 * one revokeDevice RPC, listDevices re-read, published re-render).
 * Migrated from the former ui/settings.devices and ui/react/settings.devices
 * facade fixtures with the same assertions.
 */

const self: DeviceSummary = {
  device_id: "dev_selfphone01", label: "Phone", self: true,
  created_at: 1, last_seen: 50, connected: true,
} as DeviceSummary;
const stale: DeviceSummary = {
  device_id: "dev_stale00001", label: "旧手机",
  created_at: 1, last_seen: 0, connected: false,
} as DeviceSummary;
const gone: DeviceSummary = {
  device_id: "dev_gone000001", label: "已解除",
  created_at: 1, last_seen: 1, revoked_at: 20,
} as unknown as DeviceSummary;

function mountSettingsDevices(session: Partial<LiveSession>): void {
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("settings");
      setCredential({
        daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "dev_selfphone01",
        psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
        relayOrigin: "https://pairfob.com", fp: "fp_test", label: "Phone", createdAt: 1,
      });
      applyOriginConfig({ protocol: 2, p2p: false });
      applyDeviceList([self, stale, gone]);
      attachLiveSession({ isConnected: () => true, ...session } as LiveSession);
    });
    mountApp();
  });
}

/**
 * Foreign preimages of the fields this page seeds (credential, live session,
 * phase/screen, origin config, notice) captured before the case runs so
 * afterEach restores the exact pre-case baseline through named owner actions
 * instead of default writes. The removed store.reset calls only dropped
 * subscriber registries and never the records; resetRuntime stays as the
 * original named cleanup for the device list the case seeds.
 */
const checkpoint = {
  credential: null as PairResult | null,
  lastUsed: null as string | null,
  live: null as unknown as LiveSession | null,
  phase: "boot" as Phase,
  screen: "home" as Screen,
  origin: { protocol: 2, p2p: false } as const,
  notice: null as Notice | null,
};

beforeEach(async () => {
  checkpoint.credential = computersStore.get().credential;
  checkpoint.lastUsed = computersStore.get().lastUsedDaemonId;
  checkpoint.live = computersStore.get().live;
  checkpoint.phase = connectionStore.get().phase;
  checkpoint.screen = navigationStore.get().screen;
  checkpoint.origin = { protocol: connectionStore.get().originProtocol, p2p: connectionStore.get().p2pEnabled };
  checkpoint.notice = noticesStore.get().notice;
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  registerSessionOwnerPreparer(registerSessionView);
  setLang("zh");
});

afterEach(async () => {
  // Close the imperative confirm dialog (its own portal) after the assertions,
  // before App/DOM teardown.
  closeTestDialogs();
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    // Original named cleanup for the live session and the device list.
    attachLiveSession(null);
    resetRuntime();
    // the captured preimages of the remaining seeded fields through
    // named owner actions, retaining external subscriber registries.
    setCredential(checkpoint.credential);
    setLastUsedDaemon(checkpoint.lastUsed);
    applyOriginConfig(checkpoint.origin);
    setPhase(checkpoint.phase);
    setScreen(checkpoint.screen);
    if (checkpoint.notice) {
      if (checkpoint.notice.tone === "error") showError(checkpoint.notice.text, checkpoint.notice.scope, true);
      else showStatus(checkpoint.notice.text, true, checkpoint.notice.scope);
    } else {
      clearNotice();
    }
    await happy.happyDOM.abort();
  });
});

describe("settings paired devices (actual App)", () => {
  test("hides unpaired rows and lets this phone unpair others", async () => {
    const revoked: string[] = [];
    mountSettingsDevices({
      revokeDevice: async (deviceId: string) => {
        revoked.push(deviceId);
      },
      listDevices: async () => ({
        devices: [{ device_id: "dev_selfphone01", label: "Phone", self: true, created_at: 1, last_seen: 50, connected: true }],
      }),
    });
    const app = appRoot();
    expect(app.textContent).toContain("Phone");
    expect(app.textContent).toContain("这台手机");
    // The unpair-this-phone control is a real clickable button in the danger
    // section (not merely copy text), distinct from the per-other-device
    // forget buttons; found but never clicked here.
    const selfUnpair = [...app.querySelectorAll("button")].find((el) => el.textContent?.trim() === "解除这台手机的配对");
    expect(selfUnpair).toBeInstanceOf(HTMLButtonElement);
    expect(selfUnpair?.classList.contains("btn-danger")).toBeTrue();
    expect(app.textContent).toContain("旧手机");
    expect(app.textContent).toContain("离线");
    expect(app.textContent).not.toContain("已解除配对");
    expect(app.textContent).not.toContain("dev_gone");
    const forgetButtons = () => [...app.querySelectorAll<HTMLButtonElement>(".device-forget")];
    expect(forgetButtons().map((el) => el.getAttribute("aria-label"))).toEqual(["解除旧手机的配对"]);
    await act(async () => {
      forgetButtons()[0]!.click();
    });
    const confirm = [...document.querySelectorAll("dialog button")].find((button) => button.textContent === "解除");
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("missing confirm");
    await act(async () => {
      confirm.click();
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    });
    expect(revoked).toEqual(["dev_stale00001"]);
    expect(runtimeStore.get().deviceList.map((device) => device.device_id)).toEqual(["dev_selfphone01"]);
    expect([...app.querySelectorAll(".device-name")].map((el) => el.textContent)).toEqual(["Phone"]);
    const success = t("live.unpairedDevice", { name: "旧手机" });
    // Snapshot contract...
    expect(visibleNotice()?.text).toBe(success);
    // ...and the mounted UI contract: the success status is actually rendered.
    expect(app.textContent).toContain(success);
  });
});
