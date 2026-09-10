import { expect, test, beforeEach, afterEach } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProtocolError } from "../../lib/protocol/errors";
import type { LiveSession } from "../../lib/protocol/session-types";

const { setCredential, attachLiveSession } = await import("../computers/catalog-store");
const { currentDaemonId } = await import("../computers/catalog-store");
const { setScreen, currentScreen } = await import("../../app/navigation-store");
const {
  acceptDaemonVersion, daemonVersion, refreshDaemonUpdate, startDaemonUpdate, checkDaemonRelease,
} = await import("./daemon-update");
const { DaemonUpdate, ManualUpdateHelp } = await import("./daemon-update-view");
const { setLang, t } = await import("../../lib/i18n");
const { operationCapabilities } = await import("../operations/capabilities-store");
const { pushEnabled } = await import("../connection/runtime-store");

/** Private owned root: no global renderer, no state facade. */
let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactNode): void {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
  }
  if (!root) root = createRoot(host);
  act(() => root!.render(node as React.ReactElement));
}
function paintDaemon(detailed = false): void {
  render(createElement(DaemonUpdate, { compact: !detailed }));
}
function paintManualHelp(): void {
  render(createElement(ManualUpdateHelp));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  setLang("zh");
  globalThis.fetch = (async () => new Response("1.1.0")) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
});
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
function visibility(value: string) {
  Object.defineProperty(happy.document, "visibilityState", { value, configurable: true });
  happy.document.dispatchEvent(new happy.Event("visibilitychange"));
}
afterEach(async () => {
  act(() => { visibility("hidden"); });
  Date.now = originalNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  globalThis.fetch = originalFetch;
  act(() => {
    attachLiveSession(null);
    setCredential(null);
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
  });
  setLang("zh");
  await act(async () => { await Promise.resolve(); });
});
let serial = 0;
function connect(rpc: Partial<LiveSession>, build = "1.0.0"): void {
  act(() => {
    setCredential({ daemonId: `update-test-${++serial}` } as never);
    setScreen("settings");
    attachLiveSession({ isConnected: () => true, ...rpc } as LiveSession);
    acceptDaemonVersion({ build });
  });
  globalThis.fetch = (async () => new Response("1.1.0")) as typeof fetch;
}
const idle = { available: true, phase: "idle", target: "", operation_id: "" };

test("legacy daemon offers a command, never an unsupported remote update", async () => {
  connect({ daemonUpdateStatus: async () => { throw new ProtocolError("unknown_op"); } }, "0.1.0");
  await act(async () => { await checkDaemonRelease(); });
  await act(async () => { await refreshDaemonUpdate(); });
  paintDaemon(true);
  expect(host!.textContent).toContain("pairfob update");
  expect(host!.querySelector(".daemon-update-version")?.textContent).toContain("无法确认实际版本");
  expect(host!.querySelector(".daemon-update-version")?.textContent).not.toContain("0.1.0");
  expect([...host!.querySelectorAll("button")].some(e => e.textContent === "更新电脑端")).toBeFalse();
});

test("concurrent clicks and unknown outcome do not replay the mutation", async () => {
  let writes = 0; let reject!: (e: Error) => void;
  connect({
    daemonUpdateStatus: async () => idle,
    daemonUpdate: async () => { writes += 1; return new Promise((_, r) => { reject = r; }); },
  });
  await act(async () => { await refreshDaemonUpdate(); });
  const first = startDaemonUpdate();
  await Promise.resolve();
  await act(async () => { await startDaemonUpdate(); });
  expect(writes).toBe(1);
  reject(new ProtocolError("unknown_outcome"));
  await first;
  await act(async () => { await refreshDaemonUpdate(); });
  await act(async () => { await startDaemonUpdate(); });
  expect(writes).toBe(1);
  expect(daemonVersion()?.uncertain).toBeTrue();
});

test("completion requires the target to be running", async () => {
  connect({ daemonUpdateStatus: async () => ({ ...idle, phase: "complete", target: "1.1.0", operation_id: "op_abcdefghijklmnop" }), getConfig: async () => ({ build: "1.0.0" }) });
  await act(async () => { await refreshDaemonUpdate(); });
  paintDaemon(true);
  expect(host!.textContent).toContain("等待确认运行版本");
  expect(host!.textContent).not.toContain("更新完成");
});

test("previous computer status cannot overwrite the current view", async () => {
  let resolve!: (x: unknown) => void;
  connect({ daemonUpdateStatus: () => new Promise(r => { resolve = r; }) });
  connect({ daemonUpdateStatus: async () => idle }, "2.0.0");
  await act(async () => { await refreshDaemonUpdate(); });
  resolve({ ...idle, phase: "failed" });
  await Promise.resolve(); await Promise.resolve();
  expect(daemonVersion()?.build).toBe("2.0.0");
  expect(daemonVersion()?.status?.phase).toBe("idle");
});

test("config refresh during a mutation preserves its owner and clears pending state", async () => {
  for (const fails of [false, true]) {
    let finish!: (x: unknown) => void, reject!: (e: Error) => void;
    connect({
      daemonUpdateStatus: async () => idle,
      daemonUpdate: () => new Promise((r, j) => { finish = r; reject = j; }),
    });
    await act(async () => { await refreshDaemonUpdate(); });
    const pending = startDaemonUpdate();
    await Promise.resolve();
    const owner = daemonVersion();
    expect(owner?.requesting).toBeTrue();
    act(() => acceptDaemonVersion({ build: "1.0.0" }));
    expect(daemonVersion()).toBe(owner);
    if (fails) reject(new ProtocolError("unknown_outcome"));
    else finish({ ...idle, phase: "downloading", target: "1.1.0", operation_id: "op_abcdefghijklmnop" });
    await pending;
    expect(daemonVersion()?.requesting).toBeFalse();
    if (fails) expect(daemonVersion()?.uncertain).toBeTrue();
  }
});

test("manual check bypasses release cache and updates a mounted sidebar without repainting the pane", async () => {
  connect({ daemonUpdateStatus: async () => idle });
  await act(async () => { await checkDaemonRelease(true); });
  setScreen("pane");
  render(createElement(Fragment, null,
    createElement("textarea", { defaultValue: "unfinished draft" }),
    createElement(DaemonUpdate, { compact: true }),
  ));
  const input = host!.querySelector("textarea")!;
  globalThis.fetch = (async () => new Response("1.2.0")) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  expect(host!.textContent).toContain("1.2.0");
  expect(host!.querySelector("textarea") === input).toBe(true);
  expect(input.value).toBe("unfinished draft");
  paintDaemon(true);
  let reads = 0;
  globalThis.fetch = (async () => { reads += 1; return new Response("1.3.0"); }) as typeof fetch;
  const check = [...host!.querySelectorAll("button")].find(b => b.textContent === "检查更新")!;
  act(() => check.click());
  await act(async () => { await checkDaemonRelease(); });
  expect(reads).toBe(1);
  expect(daemonVersion()?.latest).toBe("1.3.0");
});

test("failed release checks retry after one minute instead of waiting six hours", async () => {
  connect({ daemonUpdateStatus: async () => idle });
  await act(async () => { await checkDaemonRelease(true); });
  const now0 = originalNow(); let now = now0;
  Date.now = () => now;
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  expect(daemonVersion()?.error).toBeTrue();
  let reads = 0;
  globalThis.fetch = (async () => { reads += 1; return new Response("1.1.0"); }) as typeof fetch;
  await act(async () => { await checkDaemonRelease(); });
  expect(reads).toBe(0);
  now += 60001;
  await act(async () => { await checkDaemonRelease(); });
  expect(reads).toBe(1);
  expect(daemonVersion()?.error).toBeFalse();
});

test("visible pages check periodically and foreground resumes status reads without reconnecting", async () => {
  let statuses = 0;
  connect({ daemonUpdateStatus: async () => { statuses += 1; return { ...idle, phase: "downloading", target: "1.1.0", operation_id: "op_abcdefghijklmnop" }; } });
  await act(async () => { await refreshDaemonUpdate(); });
  await act(async () => { await checkDaemonRelease(true); });
  const timers = new Map<number, { fn: () => void; ms: number }>(); let id = 0;
  globalThis.setTimeout = ((fn: () => void, ms: number) => { timers.set(++id, { fn, ms }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((tId: number) => { timers.delete(tId); }) as unknown as typeof clearTimeout;
  const now0 = originalNow(); let now = now0;
  Date.now = () => now;
  const before = statuses;
  visibility("visible");
  await act(async () => { await refreshDaemonUpdate(); });
  expect(statuses).toBeGreaterThan(before);
  expect([...timers.values()].some(t => t.ms === 3000)).toBeTrue();
  const periodic = [...timers.values()].find(t => t.ms > 60000)!;
  expect(periodic).toBeDefined();
  let reads = 0;
  globalThis.fetch = (async () => { reads += 1; return new Response("1.2.0"); }) as typeof fetch;
  now += 6 * 60 * 60 * 1000 + 1;
  periodic.fn();
  await act(async () => { await checkDaemonRelease(); });
  expect(reads).toBe(1);
  visibility("hidden");
  const paused = statuses;
  happy.window.dispatchEvent(new happy.Event("focus"));
  await Promise.resolve();
  expect(statuses).toBe(paused);
});

test("real config ingestion preserves old-daemon guidance while capabilities fail closed", async () => {
  const { refreshHerdConfig } = await import("../connection/controller");
  for (const config of [null, [], { build: "0.1.0" }, { build: "1.0.0", protocol: 1 }]) {
    connect({ getConfig: async () => config as Record<string, unknown>, daemonUpdateStatus: async () => idle });
    await act(async () => { await refreshHerdConfig(); });
    await act(async () => { await refreshDaemonUpdate(); });
    expect(daemonVersion()?.incompatible).toBeTrue();
    expect(Object.values(operationCapabilities()).every(v => v === false)).toBeTrue();
    // Render with default props (<DaemonUpdate/>) to cover the default
    // compact=false detailed host as a caller would render it.
    render(createElement(DaemonUpdate));
    // The detailed marker is true and the same host carries no legacy marker.
    expect(host!.querySelector(".daemon-update-host")?.getAttribute("data-react-daemon-detailed")).toBe("true");
    expect(host!.querySelector(".daemon-update-host")?.hasAttribute("data-daemon-update")).toBe(false);
    expect(host!.textContent).toContain("pairfob update");
    expect([...host!.querySelectorAll("button")].some(b => b.textContent === "更新电脑端")).toBeFalse();
  }
});

test("offline settings and computer help offer manual upgrade without claiming a new version", () => {
  act(() => { setCredential({ daemonId: "never-connected" } as never); attachLiveSession(null); });
  paintDaemon(true);
  expect(host!.textContent).toContain("pairfob update");
  expect(host!.textContent).not.toContain("电脑端有更新");
  paintManualHelp();
  expect(host!.textContent).toContain("网络或电脑离线");
});

test("entering settings reads a very old config independently of push capability validation", async () => {
  const { refreshSettings } = await import("./actions");
  connect({
    listDevices: async () => ({ devices: [] }),
    getConfig: async () => ({ build: "0.1.0" }),
    daemonUpdateStatus: async () => { throw new ProtocolError("unknown_op"); },
  });
  await act(async () => { await refreshSettings(); });
  expect(daemonVersion()?.build).toBe("0.1.0");
  expect(daemonVersion()?.incompatible).toBeTrue();
  expect(pushEnabled() === null).toBe(true);
  paintDaemon(true);
  expect(host!.textContent).toContain("pairfob update");
});

test("release check has a visible busy state and explicit success or failure feedback", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "1.1.0");
  await act(async () => { await checkDaemonRelease(true); });
  paintDaemon(true);
  let finish!: (r: Response) => void;
  globalThis.fetch = (() => new Promise(r => { finish = r; })) as typeof fetch;
  act(() => host!.querySelector<HTMLButtonElement>(".daemon-update-check")!.click());
  const pending = checkDaemonRelease();
  const busy = host!.querySelector<HTMLButtonElement>(".daemon-update-check")!;
  expect(busy.disabled).toBeTrue();
  expect(busy.textContent).toContain("正在检查");
  expect(busy.classList.contains("btn-ghost")).toBeFalse();
  expect(host!.querySelector('[role="status"]')?.textContent).toContain("正在查询");
  await act(async () => { finish(new Response("1.1.0")); await pending; });
  expect(host!.querySelector<HTMLButtonElement>(".daemon-update-check")?.disabled).toBeFalse();
  expect(host!.querySelector('[data-tone="ok"]')?.textContent).toContain("已是最新版本");
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  expect(host!.querySelector('[data-tone="error"]')?.textContent).toContain("检查失败");
  expect(host!.querySelector('[data-tone="ok"]')).toBeNull();
  paintDaemon(true);
  expect(host!.querySelector('[data-tone="error"]')?.textContent).toContain("检查失败");
});

test("update copy follows the selected language", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "1.1.0");
  await act(async () => { await checkDaemonRelease(true); });
  setLang("en");
  paintDaemon(true);
  expect(host!.querySelector(".daemon-update-check")?.textContent).toBe("Check for updates");
  expect(host!.textContent).toContain("Computer version");
});

test("routine settings version stays compact even when background checks fail", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "ad27e83");
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  await act(async () => { await checkDaemonRelease(true); });
  paintDaemon(true);
  expect(host!.querySelector(".daemon-update-version-row")?.textContent).toContain("ad27e83");
  expect(host!.querySelector(".daemon-update-check")?.textContent).toBe("检查更新");
  expect(host!.querySelector(".daemon-update-feedback")).toBeNull();
  expect(host!.querySelector(".set-card")).toBeNull();
});

test("a compact banner can be postponed without a remote mutation", async () => {
  connect({ daemonUpdateStatus: async () => idle });
  await act(async () => { await checkDaemonRelease(); });
  await act(async () => { await refreshDaemonUpdate(); });
  render(createElement(DaemonUpdate, { compact: true }));
  expect(host!.textContent).toContain("电脑端有更新");
  expect(host!.querySelector(".daemon-update-host")?.getAttribute("data-react-daemon-detailed")).toBe("false");
  // The host carries the typed daemon attribute, never the legacy data- marker.
  expect(host!.querySelector(".daemon-update-host")?.hasAttribute("data-react-daemon-update")).toBe(true);
  expect(host!.querySelector(".daemon-update-host")?.hasAttribute("data-daemon-update")).toBe(false);
  // Capture the exact key this case writes (latest confirmed by the release
  // check above) and its pre-existing value, so cleanup restores only our own
  // record in finally (even on failure) instead of scanning the prefix.
  const ownKey = `pairfob-update-later:${currentDaemonId()}:${daemonVersion()!.latest}`;
  const ownValue = localStorage.getItem(ownKey);
  try {
    // Postponing hides the compact banner synchronously and starts no update.
    const later = [...host!.querySelectorAll("button")].find(b => b.textContent === "明天提醒")!;
    act(() => { later.click(); });
    expect(host!.querySelector("section.daemon-update")).toBeNull();
    expect(host!.querySelector<HTMLElement>(".daemon-update-host")?.hidden).toBeTrue();
    expect(daemonVersion()?.requesting).toBeFalsy();
    expect(localStorage.getItem(ownKey)).not.toBeNull();
  } finally {
    if (ownValue === null) localStorage.removeItem(ownKey); else localStorage.setItem(ownKey, ownValue);
  }
});

test("daemon update subscription preserves the React host across a release check", async () => {
  connect({ daemonUpdateStatus: async () => idle }, "1.1.0");
  await act(async () => { await checkDaemonRelease(true); });
  // Detailed body renders the host with the check button.
  paintDaemon(true);
  const updateHost = host!.querySelector(".daemon-update-host");
  expect(updateHost?.hasAttribute("data-react-daemon-update")).toBe(true);
  expect(updateHost?.hasAttribute("data-daemon-update")).toBe(false);
  const check = updateHost?.querySelector(".daemon-update-check");
  expect(check).toBeTruthy();
  await act(async () => { await checkDaemonRelease(true); });
  // The same host and check node survive the subscription update.
  expect(host!.querySelector(".daemon-update-host")?.querySelector(".daemon-update-check")).toBe(check);
  expect(host!.querySelector("[data-daemon-update]")).toBeNull();
});

test("the persistent manual update copy label follows the language on the same node", () => {
  paintManualHelp();
  // The copy button is the ManualUpdateHelp button; its label is the
  // copy-command text (pairfob update lives in the <code> element).
  const before = host!.querySelector("button")!;
  expect(before.textContent).toBe(t("update.copyCommand"));
  expect(host!.querySelector("code")?.textContent).toContain("pairfob update");
  act(() => setLang("en"));
  act(() => { root!.render(createElement(ManualUpdateHelp)); });
  expect(host!.querySelector("button")).toBe(before);
  expect(before.textContent).toBe(t("update.copyCommand"));
  expect(before.textContent).not.toBe("复制更新命令");
  act(() => setLang("zh"));
  act(() => { root!.render(createElement(ManualUpdateHelp)); });
});

test("compact later hides even when browser storage is unavailable", async () => {
  connect({ daemonUpdateStatus: async () => idle });
  await act(async () => { await checkDaemonRelease(); });
  await act(async () => { await refreshDaemonUpdate(); });
  render(createElement(DaemonUpdate, { compact: true }));
  expect(host!.querySelector("section.daemon-update")).not.toBeNull();
  // Intercept the global localStorage descriptor with a forwarding proxy: only
  // setItem throws (proving the postpone catch path actually runs), while every
  // other method binds to and forwards to the original storage. Happy DOM caches
  // the prototype Storage getter, so replacing the prototype descriptor alone
  // does not take effect.
  const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  const originalStorage = localStorage;
  const failedWrites: unknown[] = [];
  const failingStorage: Storage = new Proxy(originalStorage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "setItem") {
        return (...args: unknown[]) => {
          failedWrites.push(args[0]);
          throw new Error("storage unavailable");
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  Object.defineProperty(globalThis, "localStorage", { ...originalStorageDescriptor, value: failingStorage, configurable: true });
  try {
    const later = [...host!.querySelectorAll("button")].find(b => b.textContent === "明天提醒")!;
    act(() => { later.click(); });
    // The write was attempted (the catch path ran) and the banner still hides
    // without starting an update.
    expect(failedWrites).toHaveLength(1);
    expect(host!.querySelector("section.daemon-update")).toBeNull();
    expect(host!.querySelector<HTMLElement>(".daemon-update-host")?.hidden).toBeTrue();
    expect(daemonVersion()?.requesting).toBeFalsy();
  } finally {
    Object.defineProperty(globalThis, "localStorage", originalStorageDescriptor);
    expect(globalThis.localStorage).toBe(originalStorage);
  }
});
