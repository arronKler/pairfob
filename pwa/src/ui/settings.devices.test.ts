import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLDialogElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { fillSettings } = await import("./settings.ts");
const { t } = await import("../lib/i18n.ts");

function paint(): void {
  app.replaceChildren();
  fillSettings(app, false);
}

function click(label: string): HTMLButtonElement {
  const el = [...app.querySelectorAll("button")].find((button) => {
    return button.getAttribute("aria-label") === label || button.textContent === label;
  });
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return el;
}

async function flushed(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => {
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
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
    expect(click("解除这台手机的配对")).toBeTruthy();
    expect([...app.querySelectorAll(".device-forget")].map((el) => el.getAttribute("aria-label"))).toEqual(["解除旧手机的配对"]);

    click("解除旧手机的配对").click();
    const confirm = [...document.querySelectorAll("dialog button")].find((button) => button.textContent === "解除");
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("missing confirm");
    confirm.click();
    await flushed();

    expect(revoked).toEqual(["dev_stale00001"]);
    expect(state.deviceList.map((device) => device.device_id)).toEqual(["dev_selfphone01"]);
    expect([...app.querySelectorAll(".device-name")].map((el) => el.textContent)).toEqual(["Phone"]);
    expect(app.textContent).toContain(t("live.unpairedDevice", { name: "旧手机" }));
  });
});
