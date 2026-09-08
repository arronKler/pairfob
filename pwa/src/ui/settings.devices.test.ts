import { closeTestDialogs } from "../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { act, createElement } from "react";
import { leaveReactScreen, renderReactScreen } from "./react/root";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { app, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { SettingsContent } = await import("./react/settings");
const { setLang, t } = await import("../lib/i18n.ts");

function paint(): void {
  act(() => renderReactScreen(createElement(SettingsContent, { withBack: false })));
}

function click(label: string): HTMLButtonElement {
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return el;
}

async function flushed(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  Object.assign(state, { phase: "live", screen: "home", fullTerminal: false, agentChat: false,
    credential: null, live: null, computers: [], agents: [], paneId: "", panePinned: {}, paneTouched: {},
    listGroup: "flat", listGroupCollapsed: {}, operationBusy: false, networkOnline: true, runtimeKind: "herdr",
    herdHost: "", notice: null, settingsLoading: false, deviceList: [], devicesError: "", pushConfigError: "",
    pushEnabled: null, pushSubscribed: null });
  setLang("zh");
});

afterEach(() => {
  act(() => leaveReactScreen());
  setRenderer(() => {});
  act(() => closeTestDialogs());
  state.live = null;
  state.credential = null;
  state.deviceList = [];
  state.settingsLoading = false;
  state.devicesError = "";
  app.replaceChildren();
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
        devices: [
          { device_id: "dev_selfphone01", label: "Phone", self: true, created_at: 1, last_seen: 50, connected: true },
        ],
      }),
    } as typeof state.live;
    state.deviceList = [
      { device_id: "dev_selfphone01", label: "Phone", self: true, created_at: 1, last_seen: 50, connected: true },
      { device_id: "dev_stale00001", label: "旧手机", created_at: 1, last_seen: 0, connected: false },
      { device_id: "dev_gone000001", label: "已解除", created_at: 1, last_seen: 1, revoked_at: 20 },
    ];
    setRenderer(paint);
    paint();

    expect(app.textContent).toContain("Phone");
    expect(app.textContent).toContain("这台手机");
    expect(app.textContent).toContain("旧手机");
    expect(app.textContent).toContain("离线");
    expect(app.textContent).not.toContain("已解除配对");
    expect(app.textContent).not.toContain("dev_gone");
    expect(Boolean(click("解除这台手机的配对"))).toBe(true);
    expect([...app.querySelectorAll(".device-forget")].map((el) => el.getAttribute("aria-label"))).toEqual(["解除旧手机的配对"]);

    act(() => { click("解除旧手机的配对").click(); });
    const confirm = [...document.querySelectorAll("dialog button")].find((button) => button.textContent === "解除");
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("missing confirm");
    act(() => { confirm.click(); });
    await flushed();

    expect(revoked).toEqual(["dev_stale00001"]);
    expect(state.deviceList.map((device) => device.device_id)).toEqual(["dev_selfphone01"]);
    expect([...app.querySelectorAll(".device-name")].map((el) => el.textContent)).toEqual(["Phone"]);
    expect(app.textContent).toContain(t("live.unpairedDevice", { name: "旧手机" }));
  });
});
