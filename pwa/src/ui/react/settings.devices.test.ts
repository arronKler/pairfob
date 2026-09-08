import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { app, state } from "../../state";
import { t } from "../../lib/i18n";
import { click, flushed, installSettingsPainter, paintSettings, resetRoot } from "../../../test-support/settings-render";

beforeEach(resetTestDOM);

function paint(): void {
  installSettingsPainter(false);
  paintSettings(false);
}

afterEach(() => {
  closeTestDialogs();
  state.live = null;
  state.credential = null;
  state.deviceList = [];
  state.settingsLoading = false;
  state.devicesError = "";
  resetRoot();
});

describe("settings paired devices", () => {
  test("hides unpaired rows and lets this phone unpair others", async () => {
    const revoked: string[] = [];
    state.credential = {
      daemonId: "d_aaaaaaaaaaaaaaaaaaaa",
      deviceId: "dev_selfphone01",
      psk: new Uint8Array(32),
      daemonPk: new Uint8Array(32),
      relayOrigin: "https://pairfob.com",
      fp: "fp_test",
      label: "Phone",
      createdAt: 1,
    };
    state.live = {
      isConnected: () => true,
      revokeDevice: async (deviceId: string) => {
        revoked.push(deviceId);
      },
      listDevices: async () => ({
        devices: [{ device_id: "dev_selfphone01", label: "Phone", self: true, created_at: 1, last_seen: 50, connected: true }],
      }),
    } as typeof state.live;
    state.deviceList = [
      { device_id: "dev_selfphone01", label: "Phone", self: true, created_at: 1, last_seen: 50, connected: true },
      { device_id: "dev_stale00001", label: "旧手机", created_at: 1, last_seen: 0, connected: false },
      { device_id: "dev_gone000001", label: "已解除", created_at: 1, last_seen: 1, revoked_at: 20 },
    ];
    paint();
    expect(app.textContent).toContain("Phone");
    expect(app.textContent).toContain("这台手机");
    expect(app.textContent).toContain("旧手机");
    expect(app.textContent).toContain("离线");
    expect(app.textContent).not.toContain("已解除配对");
    expect(app.textContent).not.toContain("dev_gone");
    expect(click("解除这台手机的配对")).toBeTruthy();
    expect([...app.querySelectorAll(".device-forget")].map((el) => el.getAttribute("aria-label"))).toEqual(["解除旧手机的配对"]);
    click("解除旧手机的配对");
    const confirm = [...document.querySelectorAll("dialog button")].find((button) => button.textContent === "解除");
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("missing confirm");
    click("解除", confirm.closest("dialog")!);
    await flushed();
    expect(revoked).toEqual(["dev_stale00001"]);
    expect(state.deviceList.map((device) => device.device_id)).toEqual(["dev_selfphone01"]);
    expect([...app.querySelectorAll(".device-name")].map((el) => el.textContent)).toEqual(["Phone"]);
    expect(app.textContent).toContain(t("live.unpairedDevice", { name: "旧手机" }));
  });
});
