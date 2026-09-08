import { act } from "react";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { app, setNetworkMode, state } from "../../state";
import { t } from "../../lib/i18n";
import { click, installSettingsPainter, paintSettings, resetRoot } from "../../../test-support/settings-render";

beforeEach(resetTestDOM);

function paint(): void {
  installSettingsPainter(false);
  paintSettings(false);
}

function openHelp(topic: string): HTMLDialogElement {
  click(t("settings.helpAria", { topic }));
  const dialog = document.querySelector("dialog.help");
  if (!(dialog instanceof HTMLDialogElement)) throw new Error("missing help dialog");
  return dialog;
}

afterEach(() => {
  closeTestDialogs();
  state.p2pEnabled = false;
  state.networkMode = "auto";
  setNetworkMode("auto");
  state.pushEnabled = null;
  state.pushSubscribed = null;
  state.settingsLoading = false;
  state.deviceList = [];
  resetRoot();
});

describe("settings help copy", () => {
  test("long notes stay off the page until a help control opens a centered dialog", () => {
    paint();
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
    const close = dialog.querySelector(".help-close");
    if (!(close instanceof HTMLButtonElement)) throw new Error("missing close");
    act(() => close.click());
    expect(document.querySelector("dialog.help")).toBeNull();
    const quotaHelp = openHelp("订阅余量");
    expect(quotaHelp.textContent).toContain("当前电脑配置的账号额度，同一账号的多个会话共享");
    expect(quotaHelp.textContent).toContain("概览环显示已报告窗口中最低的剩余比例");
    expect(app.textContent).not.toContain("概览环显示已报告窗口中最低的剩余比例");
    act(() => (quotaHelp.querySelector(".help-close") as HTMLButtonElement).click());
    expect(document.querySelector("dialog.help")).toBeNull();
  });

  test("connection help covers the path; P2P-off stays a status line", () => {
    state.p2pEnabled = false;
    paint();
    expect(app.querySelector(".network-mode-row")?.textContent).toContain("当前站点未开放 P2P");
    expect(app.textContent).not.toContain("自动优先走 P2P");
    expect(openHelp("连接").textContent).toContain("自动优先走 P2P");
  });

  test("a later help tap replaces the open dialog", () => {
    paint();
    openHelp("会话默认");
    const second = openHelp("语言");
    expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
    expect(second.querySelector(".modal-title")?.textContent).toBe("语言");
    expect(second.textContent).toContain("跟随浏览器会按系统语言切换");
    expect(second.textContent).not.toContain("会话内切换只记住当前会话");
  });

  test("notifications and devices expose setup commands only from help", () => {
    state.pushEnabled = false;
    state.deviceList = [
      { device_id: "dev1", label: "Phone", self: true, created_at: 1, last_seen: 1, connected: true },
      { device_id: "dev2", label: "iPad", created_at: 1, last_seen: 1, connected: false },
    ];
    paint();
    expect(app.textContent).toContain("电脑端还没有开启 Pairfob 通知");
    expect(app.textContent).not.toContain("PAIRFOB_PUSH=1");
    expect(app.textContent).not.toContain("pairfob forget N");
    expect(openHelp("通知").textContent).toContain("PAIRFOB_PUSH=1");
    expect(openHelp("已配对设备").textContent).toContain("pairfob forget N");
    expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
  });
});
