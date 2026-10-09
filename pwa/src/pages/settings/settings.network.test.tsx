import { recordConnectionDiagnostic } from "../../lib/protocol/connection-diagnostics";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import {
  applyOriginConfig, connectionStore, networkMode, noteP2PAttempt, noteRelayRtt, sessionTransport, setNetworkMode,
  setPhase, setSessionTransport, setTransportSwitching, type Phase,
} from "../../features/connection/connection-store";
import { attachLiveSession, computersStore, setCredential, setLastUsedDaemon } from "../../features/computers/catalog-store";
import { navigationStore, setScreen, type Screen } from "../../app/navigation-store";
import { clearNotice, visibleNotice } from "../../app/notices-store";
import { setLang } from "../../lib/i18n";
import { NETWORK_MODE_KEY } from "../../lib/network-mode";
import { DirectError } from "../../lib/protocol/direct-peer";
import type { PairResult } from "../../lib/protocol/client";
import type { LiveSession } from "../../lib/protocol/session-types";
import { stopPolling } from "../../features/connection/controller";
import { setSettingsSection } from "../../features/settings/settings-section";

/**
 * Settings network transport controls against the actual mounted App.
 *
 * Setup writes named typed domain actions (published snapshots); the mounted
 * Settings page reads its connection/computers domains by subscription.
 */

type Mode = "auto" | "relay" | "p2p";

function fakeSession(switchTransport: (target: Mode) => Promise<void> | void) {
  return { isConnected: () => true, switchTransport } as LiveSession;
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
      // Default to the P2P-enabled origin; individual tests override with
      // applyOriginConfig({ p2p: false }) for the kill-switch case.
      applyOriginConfig({ protocol: 2, p2p: true });
    });
    // These cases exercise the connection page behind the Settings overview.
    setSettingsSection("connection");
    mountApp();
  });
}

function group(): HTMLElement {
  const found = appRoot().querySelector('[aria-label="网络连接方式"]');
  if (!(found instanceof HTMLElement)) throw new Error("missing network path control");
  return found;
}

/** A route row's title, without its "recommended" tag. */
function title(item: Element): string {
  return item.querySelector(".set-item-label")?.firstChild?.textContent ?? "";
}

function choice(label: string): HTMLButtonElement {
  const found = [...group().querySelectorAll("button")].find((item) => title(item) === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return found;
}

function checked(): string {
  const item = group().querySelector('[aria-checked="true"]');
  return item ? title(item) : "";
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  });
}

/**
 * Foreign preimages of the fields this page seeds beyond its original named
 * cleanup (credential, origin config, phase/screen), captured before the case
 * runs so afterEach restores the exact pre-case baseline through named owner
 * actions instead of default writes. The removed store.reset calls only
 * dropped subscriber registries; the live path, transport observations,
 * notice and stored mode keep their original named cleanup.
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
  // The help modal owns its own portal: close dialogs after the assertions,
  // before root/DOM teardown (App unmount does not dispose the portal).
  closeTestDialogs();
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    // Original named cleanup for the live path, transport observations,
    // notice, stored transport mode and its raw key.
    attachLiveSession(null);
    setTransportSwitching(false);
    setSessionTransport("relay");
    noteRelayRtt(null);
    noteP2PAttempt(null);
    clearNotice();
    setNetworkMode("auto");
    localStorage.removeItem(NETWORK_MODE_KEY);
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

describe("settings network transport (actual App)", () => {
  test("offers Auto, P2P, and Relay, then persists a manual Relay pin", async () => {
    const targets: Mode[] = [];
    applyOriginConfig({ protocol: 2, p2p: true });
    setSessionTransport("p2p");
    noteRelayRtt(18);
    attachLiveSession(fakeSession(async (target) => {
      targets.push(target);
      setSessionTransport(target === "relay" ? "relay" : "p2p");
    }));
    mountSettings();
    const app = appRoot();
    expect(app.textContent).toContain("P2P 直连 · 18 毫秒");
    expect([...group().querySelectorAll("button")].map(title)).toEqual(["自动", "仅 P2P", "仅 Relay"]);
    expect(checked()).toBe("自动");
    await act(async () => choice("仅 Relay").click());
    await settle();
    expect(targets).toEqual(["relay"]);
    expect(networkMode()).toBe("relay");
    expect(localStorage.getItem(NETWORK_MODE_KEY)).toBe("relay");
    expect(checked()).toBe("仅 Relay");
    expect((group().querySelector("button") as HTMLButtonElement).disabled).toBeFalse();
  });

  test("a P2P choice requests a direct path; Auto resumes background upgrades", async () => {
    const targets: Mode[] = [];
    applyOriginConfig({ protocol: 2, p2p: true });
    setNetworkMode("relay");
    setSessionTransport("relay");
    noteRelayRtt(42);
    attachLiveSession(fakeSession(async (target) => {
      targets.push(target);
      if (target === "p2p") setSessionTransport("p2p");
    }));
    mountSettings();
    expect(appRoot().textContent).toContain("Relay 中继 · 42 毫秒");
    await act(async () => choice("仅 P2P").click());
    await settle();
    expect(targets).toEqual(["p2p"]);
    expect(networkMode()).toBe("p2p");
    expect(checked()).toBe("仅 P2P");
    await act(async () => choice("自动").click());
    await settle();
    expect(targets).toEqual(["p2p", "auto"]);
    expect(networkMode()).toBe("auto");
  });

  test("disables P2P when the origin kill switch is off", () => {
    attachLiveSession(fakeSession(() => {}));
    mountSettings();
    act(() => applyOriginConfig({ protocol: 2, p2p: false }));
    expect(choice("仅 P2P").disabled).toBeTrue();
    expect(choice("自动").disabled).toBeFalse();
    expect(choice("仅 Relay").disabled).toBeFalse();
    expect(appRoot().querySelector(".route-group .set-foot")?.textContent).toContain("当前站点未开放 P2P");
  });

  test("keeps Relay usable and reports a failed manual P2P attempt", async () => {
    applyOriginConfig({ protocol: 2, p2p: true });
    attachLiveSession(fakeSession(async () => {
      throw new Error("ICE failed");
    }));
    mountSettings();
    await act(async () => choice("仅 P2P").click());
    await settle();
    expect(visibleNotice()?.text).toContain("已继续使用 Relay");
    expect(networkMode()).toBe("p2p");
    // The failed switch leaves the live path on relay and leaves the P2P
    // control usable again instead of sticking busy.
    expect(sessionTransport()).toBe("relay");
    expect(checked()).toBe("仅 P2P");
    expect(choice("仅 P2P").disabled).toBeFalse();
    expect(group().getAttribute("aria-busy")).not.toBe("true");
  });

  test("explains a browser-side ICE timeout without exposing raw network data", async () => {
    applyOriginConfig({ protocol: 2, p2p: true });
    attachLiveSession(fakeSession(async () => {
      throw new DirectError("ice_timeout", "candidate 192.0.2.1 failed");
    }));
    mountSettings();
    await act(async () => choice("仅 P2P").click());
    await settle();
    expect(visibleNotice()?.text).toContain("这个浏览器未能收集直连地址");
    expect(visibleNotice()?.text).not.toContain("192.0.2.1");
  });

  test("explains a restored P2P preference while Relay bootstraps or retries", async () => {
    const targets: Mode[] = [];
    applyOriginConfig({ protocol: 2, p2p: true });
    setNetworkMode("p2p");
    setSessionTransport("relay");
    noteRelayRtt(36);
    attachLiveSession(fakeSession(async (target) => { targets.push(target); }));
    mountSettings();
    const app = appRoot();
    expect(app.textContent).toContain("P2P 优先 · 当前 Relay · 36 毫秒");
    // The P2P row itself says it keeps retrying and that choosing it again retries now.
    expect(choice("仅 P2P").querySelector(".set-item-sub")?.textContent).toContain("后台继续重试");
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(checked()).toBe("仅 P2P");
    await act(async () => choice("仅 P2P").click());
    await settle();
    expect(targets).toEqual(["p2p"]);
  });

  test("shows the last automatic P2P failure on Auto without exposing addresses", () => {
    applyOriginConfig({ protocol: 2, p2p: true });
    setSessionTransport("relay");
    noteRelayRtt(24);
    noteP2PAttempt({ result: "failed", extra: "ice_timeout" });
    attachLiveSession(fakeSession(() => {}));
    mountSettings();
    const app = appRoot();
    expect(app.textContent).toContain("Relay 中继 · 24 毫秒");
    // The failure reads under the link it explains, inside the computer panel.
    const fail = app.querySelector(".computer-panel .cp-note");
    expect(fail?.textContent).toContain("这个浏览器未能收集直连地址");
    expect(app.textContent).not.toContain("ice_timeout");
  });

  test("shows a channel failure as a warning under the computer link", () => {
    applyOriginConfig({ protocol: 2, p2p: true });
    setSessionTransport("relay");
    noteRelayRtt(18);
    noteP2PAttempt({ result: "failed", extra: "channel_timeout" });
    attachLiveSession(fakeSession(() => {}));
    mountSettings();
    const app = appRoot();
    const fail = app.querySelector(".computer-panel .cp-note");
    expect(fail?.textContent).toBe("两端网络无法互相直连，常见于蜂窝网络或严格 NAT。");
    expect(fail?.classList.contains("is-warn")).toBeTrue();
  });
});

test("connection diagnostics export works from settings while disconnected", async () => {
  mountSettings();
  recordConnectionDiagnostic({ event: "disconnect", reason: "heartbeat_timeout" });
  const row = [...appRoot().querySelectorAll(".set-item")].find((item) => item.querySelector(".set-item-label")?.textContent === "导出连接诊断");
  const button = row?.querySelector<HTMLButtonElement>(".set-action");
  expect(button).toBeDefined();
  let blob: Blob | undefined;
  let downloaded = "";
  let release = () => undefined;
  const create = spyOn(URL, "createObjectURL").mockImplementation((value) => { blob = value as Blob; return "blob:diagnostics-test"; });
  const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const click = spyOn(happy.HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloaded = this.download; });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => { release = callback; return 1; }) as typeof setTimeout);
  try {
    button!.click();
    expect(downloaded).toMatch(/^pairfob-connection-\d+\.json$/);
    const report = JSON.parse(await blob!.text());
    expect(report.records.some((record: { reason?: string }) => record.reason === "heartbeat_timeout")).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    release();
    expect(revoke).toHaveBeenCalledWith("blob:diagnostics-test");
    expect(document.querySelector('a[download^="pairfob-connection-"]')).toBeNull();
  } finally {
    timer.mockRestore(); click.mockRestore(); revoke.mockRestore(); create.mockRestore();
  }
});
