import { resetTestDOM } from "../../../test-support/boot-dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { ProtocolError } from "../../lib/protocol/errors";
import type { LiveSession } from "../../lib/protocol/session-types";
import { app, state } from "../../state";
import { setRenderer } from "../../paint";
import { acceptDaemonVersion, checkDaemonRelease, daemonVersion, refreshDaemonUpdate } from "../../daemon-update";
import { setLang } from "../../lib/i18n";
import { DaemonUpdate, ManualUpdateHelp } from "./daemon-update";
import { click, mount, resetRoot } from "../../../test-support/settings-render";

beforeEach(resetTestDOM);

const originalFetch = globalThis.fetch;
const idle = { available: true, phase: "idle", target: "", operation_id: "" };
let serial = 0;

function connect(rpc: Partial<LiveSession>, build = "1.0.0") {
  state.credential = { daemonId: `update-test-${++serial}` } as typeof state.credential;
  state.screen = "settings";
  state.live = { isConnected: () => true, ...rpc } as LiveSession;
  globalThis.fetch = (async () => new Response("1.1.0")) as typeof fetch;
  acceptDaemonVersion({ build });
}

function paintDetailed(): void {
  setRenderer(() => mount(createElement(DaemonUpdate)));
  mount(createElement(DaemonUpdate));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  state.live = null;
  state.credential = null;
  setLang("zh");
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("pairfob-update-later:")) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
  resetRoot();
});

test("legacy daemon offers a command, never an unsupported remote update", async () => {
  connect({ daemonUpdateStatus: async () => { throw new ProtocolError("unknown_op"); } }, "0.1.0");
  await checkDaemonRelease();
  await refreshDaemonUpdate();
  paintDetailed();
  expect(app.textContent).toContain("pairfob update");
  expect([...app.querySelectorAll("button")].some((e) => e.textContent === "更新电脑端")).toBeFalse();
});

test("completion requires the target to be running", async () => {
  connect({
    daemonUpdateStatus: async () => ({ ...idle, phase: "complete", target: "1.1.0", operation_id: "op_abcdefghijklmnop" }),
    getConfig: async () => ({ build: "1.0.0" }),
  });
  await refreshDaemonUpdate();
  paintDetailed();
  expect(app.textContent).toContain("等待确认运行版本");
  expect(app.textContent).not.toContain("更新完成");
});

test("release check has a visible busy state and explicit success or failure feedback", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "1.1.0");
  await act(async () => { await checkDaemonRelease(true); });
  paintDetailed();
  let finish!: (r: Response) => void;
  globalThis.fetch = (() => new Promise((r) => { finish = r; })) as typeof fetch;
  act(() => app.querySelector<HTMLButtonElement>(".daemon-update-check")!.click());
  const pending = checkDaemonRelease();
  paintDetailed();
  const busy = app.querySelector<HTMLButtonElement>(".daemon-update-check")!;
  expect(busy.disabled).toBeTrue();
  expect(busy.textContent).toContain("正在检查");
  expect(busy.classList.contains("btn-ghost")).toBeFalse();
  expect(app.querySelector('[role="status"]')?.textContent).toContain("正在查询");
  await act(async () => { finish(new Response("1.1.0")); await pending; });
  paintDetailed();
  expect(app.querySelector<HTMLButtonElement>(".daemon-update-check")?.disabled).toBeFalse();
  expect(app.querySelector('[data-tone="ok"]')?.textContent).toContain("已是最新版本");
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  paintDetailed();
  expect(app.querySelector('[data-tone="error"]')?.textContent).toContain("检查失败");
  expect(app.querySelector('[data-tone="ok"]')).toBeNull();
});

test("update copy follows the selected language", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "1.1.0");
  await act(async () => { await checkDaemonRelease(true); });
  setLang("en");
  paintDetailed();
  expect(app.querySelector(".daemon-update-check")?.textContent).toBe("Check for updates");
  expect(app.textContent).toContain("Computer version");
});

test("routine settings version stays compact even when background checks fail", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "ad27e83");
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  paintDetailed();
  expect(app.querySelector(".daemon-update-version-row")?.textContent).toContain("ad27e83");
  expect(app.querySelector(".daemon-update-check")?.textContent).toBe("检查更新");
  expect(app.querySelector(".daemon-update-feedback")).toBeNull();
  expect(app.querySelector(".set-card")).toBeNull();
});

test("offline settings and computer help offer manual upgrade without claiming a new version", () => {
  state.credential = { daemonId: "never-connected" } as typeof state.credential;
  state.live = null;
  paintDetailed();
  expect(app.textContent).toContain("pairfob update");
  expect(app.textContent).not.toContain("电脑端有更新");
  resetRoot();
  mount(createElement(ManualUpdateHelp));
  expect(app.textContent).toContain("网络或电脑离线");
});

test("compact banner can be postponed without a remote mutation", async () => {
  connect({ daemonUpdateStatus: async () => idle });
  await checkDaemonRelease();
  await refreshDaemonUpdate();
  const paintCompact = () => mount(createElement(DaemonUpdate, { compact: true }));
  setRenderer(paintCompact);
  paintCompact();
  expect(app.textContent).toContain("电脑端有更新");
  expect(app.querySelector(".daemon-update-host")?.getAttribute("data-react-daemon-detailed")).toBe("false");
  expect(app.querySelector(".daemon-update-host")?.hasAttribute("data-daemon-update")).toBe(false);
  click("明天提醒");
  expect(app.querySelector("section.daemon-update")).toBeNull();
  expect((app.querySelector(".daemon-update-host") as HTMLElement | null)?.hidden).toBeTrue();
  expect(daemonVersion()?.requesting).toBeFalsy();
});

test("incompatible config keeps the manual command and hides the remote update action", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "0.1.0");
  await refreshDaemonUpdate();
  paintDetailed();
  expect(app.textContent).toContain("pairfob update");
  expect([...app.querySelectorAll("button")].some((b) => b.textContent === "更新电脑端")).toBeFalse();
  expect(app.querySelector(".daemon-update-host")?.getAttribute("data-react-daemon-detailed")).toBe("true");
  expect(app.querySelector(".daemon-update-host")?.hasAttribute("data-daemon-update")).toBe(false);
});

test("daemon subscription preserves children of the React host", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "1.1.0");
  await act(async () => { await checkDaemonRelease(true); });
  paintDetailed();
  const host = app.querySelector(".daemon-update-host");
  expect(host?.hasAttribute("data-react-daemon-update")).toBe(true);
  expect(host?.hasAttribute("data-daemon-update")).toBe(false);
  const check = host?.querySelector(".daemon-update-check");
  expect(check).toBeTruthy();
  await act(async () => { await checkDaemonRelease(true); });
  expect(app.querySelector(".daemon-update-host")?.querySelector(".daemon-update-check")).toBe(check);
  expect(app.querySelector("[data-daemon-update]")).toBeNull();
});
