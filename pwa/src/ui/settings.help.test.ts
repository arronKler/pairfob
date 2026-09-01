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

const { app, setNetworkMode, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { fillSettings } = await import("./settings.ts");
const { t } = await import("../lib/i18n.ts");

function paint(): void {
  app.replaceChildren();
  fillSettings(app, false);
}

function help(topic: string): HTMLButtonElement {
  const el = app.querySelector(`[aria-label="${t("settings.helpAria", { topic })}"]`);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing help for ${topic}`);
  return el;
}

function openHelp(topic: string): HTMLDialogElement {
  help(topic).click();
  const dialog = document.querySelector("dialog.help");
  if (!(dialog instanceof HTMLDialogElement)) throw new Error("missing help dialog");
  return dialog;
}

afterEach(() => {
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  state.p2pEnabled = false;
  state.networkMode = "auto";
  setNetworkMode("auto");
  state.pushEnabled = null;
  state.pushSubscribed = null;
  state.settingsLoading = false;
  state.deviceList = [];
  app.replaceChildren();
});

describe("settings help copy", () => {
  test("long notes stay off the page until a help control opens a centered dialog", () => {
    setRenderer(paint);
    paint();

    expect([...app.querySelectorAll(".set-heading")].map((row) => ({
      title: row.querySelector(".set-title")?.textContent,
      help: row.querySelector(".set-help") !== null,
    }))).toEqual([
      { title: "连接", help: true },
      { title: "语言", help: true },
      { title: "会话列表", help: true },
      { title: "模式", help: true },
      { title: "输入", help: true },
      { title: "通知", help: false },
      { title: "已配对设备", help: false },
      { title: "危险操作", help: false },
    ]);
    expect(app.querySelectorAll(".set-help").length).toBe(5);
    expect(app.textContent).not.toContain("会话内切换只记住当前会话");
    expect(app.textContent).not.toContain("不会替换现在这台");
    expect(app.textContent).not.toContain("默认平铺全部会话");
    expect(app.textContent).not.toContain("跟随浏览器会按系统语言切换");
    expect(app.textContent).toContain("解除后，这台手机会立即断开并删除本地凭证");

    const dialog = openHelp("模式");
    expect(dialog.classList.contains("modal")).toBeTrue();
    expect(dialog.classList.contains("sheet")).toBeFalse();
    expect(dialog.querySelector(".modal-title")?.textContent).toBe("模式");
    expect(dialog.textContent).toContain("会话内切换只记住当前会话");
    expect(app.textContent).not.toContain("会话内切换只记住当前会话");

    const close = dialog.querySelector(".help-close");
    if (!(close instanceof HTMLButtonElement)) throw new Error("missing close");
    close.click();
    expect(document.querySelector("dialog.help")).toBeNull();
  });

  test("connection help covers the path and add-computer notes; P2P-off stays a status line", () => {
    state.p2pEnabled = false;
    setRenderer(paint);
    paint();

    expect(app.querySelector(".network-mode-row")?.textContent).toContain("当前站点未开放 P2P");
    expect(app.textContent).not.toContain("自动优先走 P2P");
    const dialog = openHelp("连接");
    expect(dialog.textContent).toContain("自动优先走 P2P");
    expect(dialog.textContent).toContain("不会替换现在这台");
  });

  test("a later help tap replaces the open dialog", () => {
    setRenderer(paint);
    paint();
    openHelp("模式");
    const second = openHelp("输入");
    expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
    expect(second.querySelector(".modal-title")?.textContent).toBe("输入");
    expect(second.textContent).toContain("组字写完再按 Enter");
    expect(second.textContent).not.toContain("会话内切换只记住当前会话");
  });

  test("notifications and devices expose setup commands only from help", () => {
    state.pushEnabled = false;
    state.deviceList = [{ device_id: "dev1", label: "Phone", self: true, created_at: 1, last_seen: 1 }];
    setRenderer(paint);
    paint();

    expect(app.textContent).toContain("电脑端还没有开启 Pairfob 通知");
    expect(app.textContent).not.toContain("PAIRFOB_PUSH=1");
    expect(app.textContent).not.toContain("pairfob device revoke");

    expect(openHelp("通知").textContent).toContain("PAIRFOB_PUSH=1");
    expect(openHelp("已配对设备").textContent).toContain("pairfob device revoke <device_id>");
    expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
  });
});
