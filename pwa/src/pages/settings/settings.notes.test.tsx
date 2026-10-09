import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { applyDeviceList, setPushConfigError, setPushEnabled } from "../../features/connection/runtime-store";
import { applyOriginConfig, connectionStore, setPhase, type Phase } from "../../features/connection/connection-store";
import { attachLiveSession, computersStore, setCredential, setLastUsedDaemon } from "../../features/computers/catalog-store";
import { navigationStore, setScreen, type Screen } from "../../app/navigation-store";
import { setLang, t } from "../../lib/i18n";
import { setSettingsSection } from "../../features/settings/settings-section";
import type { PairResult } from "../../lib/protocol/client";
import { stopPolling } from "../../features/connection/controller";
import { closeTestDialogs } from "../../../test-support/close-dialogs";

/**
 * Settings explanations against the actual mounted App. There are no help
 * dialogs: each card carries a one-line note, notification setup steps expand
 * inside the card, and read failures land on the row they belong to.
 */

function mountSettings(): void {
  act(() => {
    batch(() => {
      setPhase("live");
      setScreen("settings");
      setCredential({
        daemonId: "d_aaaaaaaaaaaaaaaaaaaa", deviceId: "dev_phone",
        psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
        relayOrigin: "https://pairfob.com", fp: "fp", label: "Phone", createdAt: 1,
      });
      attachLiveSession({ isConnected: () => true, listDevices: async () => ({ devices: [] }), getConfig: async () => ({ capabilities: {} }), agentQuota: async () => [] } as never);
      applyOriginConfig({ protocol: 2, p2p: true });
    });
    mountApp();
  });
}

/**
 * Foreign preimages of the fields this page seeds (credential, live session,
 * origin config, phase/screen) captured before the case runs so afterEach
 * restores the exact pre-case baseline through named owner actions instead of
 * default writes. The removed store.reset calls only dropped subscriber
 * registries; push/device runtime fields keep their original named cleanup.
 */
const checkpoint = {
  credential: null as PairResult | null,
  lastUsed: null as string | null,
  phase: "boot" as Phase,
  screen: "home" as Screen,
  origin: { protocol: 2, p2p: true } as const,
};

beforeEach(async () => {
  checkpoint.credential = computersStore.get().credential;
  checkpoint.lastUsed = computersStore.get().lastUsedDaemonId;
  checkpoint.phase = connectionStore.get().phase;
  checkpoint.screen = navigationStore.get().screen;
  checkpoint.origin = { protocol: connectionStore.get().originProtocol, p2p: connectionStore.get().p2pEnabled };
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  registerSessionOwnerPreparer(registerSessionView);
  setLang("zh");
});

afterEach(async () => {
  // The help modal owns its own portal: close the dialogs after the
  // assertions, before App/DOM teardown so no portal outlives the suite.
  closeTestDialogs();
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    // Original named cleanup for the live session and the push/device runtime
    // fields this page seeds.
    attachLiveSession(null);
    setPushEnabled(null);
    setPushConfigError("");
    applyDeviceList([]);
    // Restore the captured preimages of the other seeded fields through named
    // owner actions, retaining external subscriber registries.
    setCredential(checkpoint.credential);
    setLastUsedDaemon(checkpoint.lastUsed);
    applyOriginConfig(checkpoint.origin);
    setPhase(checkpoint.phase);
    setScreen(checkpoint.screen);
    await happy.happyDOM.abort();
  });
});

/** Install the three web-push globals the row checks, returning their removal. */
function stubWebPush(): () => void {
  const added: Array<[object, string]> = [];
  for (const [target, key] of [[navigator, "serviceWorker"], [window, "PushManager"], [window, "Notification"]] as const) {
    if (key in target) continue;
    Object.defineProperty(target, key, { configurable: true, value: {} });
    added.push([target, key]);
  }
  return () => { for (const [target, key] of added) delete (target as Record<string, unknown>)[key]; };
}

function openComputerPage(): void {
  const panel = appRoot().querySelector<HTMLButtonElement>("button.cp-main");
  if (!(panel instanceof HTMLButtonElement)) throw new Error("missing computer panel");
  act(() => panel.click());
}

function buttonLabelled(text: string): HTMLButtonElement {
  const found = [...appRoot().querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.includes(text));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button ${text}`);
  return found;
}

describe("settings notes and inline steps (actual App)", () => {
  test("the overview explains in notes and never opens a help dialog", () => {
    mountSettings();
    const app = appRoot();
    expect([...app.querySelectorAll(".set-group-label")].map((el) => el.firstElementChild?.textContent))
      .toEqual(["订阅余量", "会话默认", "这台设备"]);
    expect(app.querySelector(".set-help")).toBeNull();
    expect(app.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    expect(app.querySelector(".session-defaults .set-foot")?.textContent).toContain("只影响新打开的会话");
    // Computer-owned actions live on the computer page, not the overview.
    expect(app.textContent).not.toContain("解除这台设备的配对");
    expect(app.textContent).not.toContain("导出连接诊断");
    expect(app.textContent).not.toContain("危险操作");
  });

  test("the computer page names its computer once: in the panel at rest, in the bar once the panel has scrolled under it", async () => {
    mountSettings();
    openComputerPage();
    const app = appRoot();
    const heading = app.querySelector(".topbar-title")!;
    const name = app.querySelector<HTMLElement>(".cp-name")!;
    const bar = app.querySelector<HTMLElement>(".topbar")!;
    const at = (top: number, bottom: number) => () => ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON() {} });
    const scrolled = async () => {
      await act(async () => {
        document.dispatchEvent(new happy.Event("scroll") as unknown as Event);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await Promise.resolve();
      });
    };
    expect(heading.classList.contains("sr-only")).toBeFalse();
    expect(heading.textContent).toBe(t("settings.computer"));
    expect(name.textContent).not.toBe(t("settings.computer"));
    bar.getBoundingClientRect = at(0, 52);
    // Half under the bar is still in sight.
    name.getBoundingClientRect = at(40, 62);
    await scrolled();
    expect(heading.textContent).toBe(t("settings.computer"));
    name.getBoundingClientRect = at(20, 42);
    await scrolled();
    expect(heading.textContent).toBe(name.textContent);
    name.getBoundingClientRect = at(80, 102);
    await scrolled();
    expect(heading.textContent).toBe(t("settings.computer"));
    // Back on the overview the bar is the family's own title again.
    act(() => setSettingsSection("overview"));
    expect(app.querySelector(".topbar-title, .settings-title")?.textContent).toBe(t("settings.title"));
  });

  test("the computer page explains a P2P-off site under the route", () => {
    mountSettings();
    act(() => applyOriginConfig({ protocol: 2, p2p: false }));
    openComputerPage();
    const app = appRoot();
    expect(app.querySelector("button.cp-main")).toBeNull();
    expect(app.querySelector(".route-group .set-foot")?.textContent).toContain("当前站点未开放 P2P");
    const p2p = [...app.querySelectorAll<HTMLButtonElement>('.route-group [role="radio"]')]
      .find((el) => el.querySelector(".set-item-label")?.textContent === "仅 P2P");
    expect(p2p?.disabled).toBeTrue();
    expect(buttonLabelled("解除这台设备的配对").classList.contains("set-danger")).toBeTrue();
    expect(app.textContent).toContain("解除后，这台设备会立即断开并删除本地凭证");
  });

  test("notification setup steps expand inside the card instead of a dialog", () => {
    // The row only offers setup on a browser that can take web push.
    const restore = stubWebPush();
    try {
      stepsExpandInPlace();
    } finally {
      restore();
    }
  });

  function stepsExpandInPlace(): void {
    mountSettings();
    act(() => setPushEnabled(false));
    const app = appRoot();
    const item = app.querySelector(".notification-item")!;
    expect(item.querySelector(".set-item-sub")?.textContent).toBe(t("settings.pushComputerOff"));
    expect(app.textContent).not.toContain("PAIRFOB_PUSH=1");
    const howto = buttonLabelled("怎么开启");
    expect(howto.getAttribute("aria-expanded")).toBe("false");
    act(() => howto.click());
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(buttonLabelled("怎么开启").getAttribute("aria-expanded")).toBe("true");
    const steps = [...app.querySelectorAll(".notification-item .command-line code")].map((el) => el.textContent);
    expect(steps).toEqual(["PAIRFOB_PUSH=1\nPAIRFOB_VAPID_SUBJECT=mailto:you@example.com", "pairfob service restart"]);
    act(() => buttonLabelled("怎么开启").click());
    expect(app.textContent).not.toContain("PAIRFOB_PUSH=1");
  }

  test("a notification read failure stays on its row with a retry", () => {
    mountSettings();
    act(() => setPushConfigError(t("err.pushStatusLoad")));
    const app = appRoot();
    expect(app.querySelector(".notification-item .set-item-sub.is-error")?.textContent).toBe(t("err.pushStatusLoad"));
    expect(app.querySelector(".notification-item .set-action")?.textContent).toBe(t("retry"));
    expect(app.querySelector(".retry")).toBeNull();
  });

  test("the devices note carries the forget command on the computer page", () => {
    mountSettings();
    act(() => applyDeviceList([
      { device_id: "dev1", label: "Phone", self: true, created_at: 1, last_seen: 1, connected: true } as never,
      { device_id: "dev2", label: "iPad", created_at: 1, last_seen: 1, connected: false } as never,
    ]));
    openComputerPage();
    const note = appRoot().querySelector(".devices-group .set-foot");
    expect(note?.textContent).toContain("pairfob forget N");
    expect(note?.querySelector("code")?.textContent).toBe("pairfob forget N");
  });
});
