import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { applyDeviceList, setPushEnabled } from "../../features/connection/runtime-store";
import { applyOriginConfig, connectionStore, setPhase, type Phase } from "../../features/connection/connection-store";
import { attachLiveSession, computersStore, setCredential, setLastUsedDaemon } from "../../features/computers/catalog-store";
import { navigationStore, setScreen, type Screen } from "../../app/navigation-store";
import { setLang, t } from "../../lib/i18n";
import type { PairResult } from "../../lib/protocol/client";
import { stopPolling } from "../../features/connection/controller";
import { closeTestDialogs } from "../../../test-support/close-dialogs";

/**
 * Settings help dialogs against the actual mounted App. Long copy stays out of
 * the page and only appears in the centered help dialog; a later help tap
 * replaces the open dialog.
 */

function helpButton(topic: string): HTMLButtonElement {
  const found = [...appRoot().querySelectorAll<HTMLButtonElement>("button.set-help")]
    .find((el) => el.getAttribute("aria-label") === t("settings.helpAria", { topic }));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing help for ${topic}`);
  return found;
}

function openHelp(topic: string): HTMLDialogElement {
  act(() => helpButton(topic).click());
  const dialog = document.querySelector("dialog.help");
  if (!(dialog instanceof HTMLDialogElement)) throw new Error("missing help dialog");
  return dialog;
}

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

describe("settings help copy (actual App)", () => {
  test("long notes stay off the page until a help control opens a centered dialog", () => {
    mountSettings();
    const app = appRoot();
    expect(
      [...app.querySelectorAll(".set-heading")].map((row) => ({
        title: row.querySelector(".set-title")?.textContent,
        help: row.querySelector(".set-help") !== null,
      })),
    ).toEqual([
      { title: "连接", help: true },
      { title: "订阅余量", help: true },
      { title: "语言", help: true },
      { title: "会话列表", help: true },
      { title: "会话默认", help: true },
      { title: "通知", help: false },
      { title: "已配对设备", help: false },
      { title: "危险操作", help: false },
    ]);
    expect(app.querySelectorAll(".set-help").length).toBe(5);
    expect(app.textContent).not.toContain("会话内切换只记住当前会话");
    expect(app.textContent).not.toContain("默认平铺全部会话");
    expect(app.textContent).not.toContain("跟随浏览器会按系统语言切换");
    expect(app.textContent).not.toContain("概览环显示已报告窗口中最低的剩余比例");
    expect(app.textContent).not.toContain("当前电脑配置的账号额度，同一账号的多个会话共享");
    expect(app.textContent).toContain("解除后，这台手机会立即断开并删除本地凭证");
    const dialog = openHelp("会话默认");
    expect(dialog.classList.contains("modal")).toBeTrue();
    expect(dialog.classList.contains("sheet")).toBeFalse();
    expect(dialog.querySelector(".modal-title")?.textContent).toBe("会话默认");
    expect(dialog.textContent).toContain("会话内切换只记住当前会话");
    expect(dialog.textContent).toContain("组字写完再按 Enter");
    expect(app.textContent).not.toContain("会话内切换只记住当前会话");
    act(() => (dialog.querySelector(".help-close") as HTMLButtonElement).click());
    expect(document.querySelector("dialog.help")).toBeNull();
    const quotaHelp = openHelp("订阅余量");
    expect(quotaHelp.textContent).toContain("当前电脑配置的账号额度，同一账号的多个会话共享");
    expect(quotaHelp.textContent).toContain("概览环显示已报告窗口中最低的剩余比例");
    expect(app.textContent).not.toContain("概览环显示已报告窗口中最低的剩余比例");
    act(() => (quotaHelp.querySelector(".help-close") as HTMLButtonElement).click());
    expect(document.querySelector("dialog.help")).toBeNull();
  });

  test("connection help covers the path; P2P-off stays a status line", () => {
    mountSettings();
    act(() => applyOriginConfig({ protocol: 2, p2p: false }));
    const app = appRoot();
    expect(app.querySelector(".network-mode-row")?.textContent).toContain("当前站点未开放 P2P");
    expect(app.textContent).not.toContain("自动优先走 P2P");
    expect(openHelp("连接").textContent).toContain("自动优先走 P2P");
  });

  test("a later help tap replaces the open dialog", () => {
    mountSettings();
    openHelp("会话默认");
    const second = openHelp("语言");
    expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
    expect(second.querySelector(".modal-title")?.textContent).toBe("语言");
    expect(second.textContent).toContain("跟随浏览器会按系统语言切换");
    expect(second.textContent).not.toContain("会话内切换只记住当前会话");
  });

  test("notifications and devices expose setup commands only from help", () => {
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
        setPushEnabled(false);
        applyDeviceList([
          { device_id: "dev1", label: "Phone", self: true, created_at: 1, last_seen: 1, connected: true } as never,
          { device_id: "dev2", label: "iPad", created_at: 1, last_seen: 1, connected: false } as never,
        ]);
      });
      mountApp();
    });
    const app = appRoot();
    expect(app.textContent).toContain("电脑端还没有开启 Pairfob 通知");
    expect(app.textContent).not.toContain("PAIRFOB_PUSH=1");
    expect(app.textContent).not.toContain("pairfob forget N");
    expect(openHelp("通知").textContent).toContain("PAIRFOB_PUSH=1");
    expect(openHelp("已配对设备").textContent).toContain("pairfob forget N");
    expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
  });
});
