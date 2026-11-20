import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { SettingsContent } from "./settings-page";
import { setSettingsSection } from "../../features/settings/settings-section";
import { attachLiveSession, computersStore, setCredential } from "../../features/computers/catalog-store";
import { applyCapabilities } from "../../features/operations/capabilities-store";
import { clearDesktopSetupDismissals } from "../../features/remote-desktop/desktop-setup-prompt";
import { forgetConsole, saveConsole } from "../../lib/recovery-console";
import type { LiveSession, PairResult } from "../../lib/protocol/client";

/**
 * Content-only component contract on a private owned root.
 *
 * SettingsContent renders the settings body; the page wrapper and top bar
 * belong to the screen/shell that mounts it (SettingsScreen / DeskShell), so
 * the bare content with no back bar adds no .page wrapper of its own. This
 * fixture deliberately owns its own React root and typed setup — no global app
 * root — and unmounts after the assertions.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function sampleHost(daemonId = "d_test_1234567890"): PairResult {
  return {
    daemonId,
    deviceId: "dev_1",
    hostname: "mac",
    label: "Mac",
    fp: "fp",
    relayOrigin: "https://pairfob.com",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    createdAt: 1,
  } as PairResult;
}

beforeEach(async () => {
  await resetTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  setLang("zh");
  clearDesktopSetupDismissals();
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
});
afterEach(async () => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  clearDesktopSetupDismissals();
  forgetConsole("d_test_1234567890");
  attachLiveSession(null);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
});

test("content with no back bar renders no extra page wrapper", () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(SettingsContent, { withBack: false })));
  expect(host.querySelector(".page")).toBeNull();
  expect(host.querySelector(".topbar")).toBeNull();
  expect(host.querySelector(".settings-title")?.textContent).toBe("设置");
  expect(host.querySelector(".computer-panel .cp-main")).toBeTruthy();
  expect(host.querySelector(".set-group-label")).toBeTruthy();
});

test("the link starts at this device, named for any device and marked for the one it is", () => {
  const linkStart = (userAgent: string) => {
    Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(SettingsContent, { withBack: false })));
    const node = host.querySelector(".cp-link .cp-node:not(.is-end)")!;
    const result = { label: node.textContent, mark: node.querySelector("svg")?.getAttribute("class") ?? "" };
    act(() => root!.unmount());
    root = null;
    host.remove();
    return result;
  };
  try {
    const phone = linkStart("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1");
    expect(phone.label).toBe("这台设备");
    expect(phone.mark).toContain("lucide-smartphone");
    const desktop = linkStart("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36");
    expect(desktop.label).toBe("这台设备");
    // Not the monitor: that one marks the computer at the other end of the link.
    expect(desktop.mark).toContain("lucide-laptop");
  } finally {
    // Drop the override; the realm's own user agent shows through again.
    delete (navigator as { userAgent?: string }).userAgent;
  }
});

test("computer details section renders unified DesktopSettingsSection without standalone duplicate console", () => {
  const prev = computersStore.get().credential;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  try {
    act(() => {
      setCredential(sampleHost());
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: true, control_desktop: true }, []);
      setSettingsSection("connection");
      root!.render(createElement(SettingsContent, { withBack: false }));
    });
    expect(host.querySelectorAll(".rd-settings-group")).toHaveLength(1);
    expect(host.querySelectorAll(".recovery-console")).toHaveLength(1);
    expect(host.querySelector(".rd-settings-group .recovery-console")).not.toBeNull();
  } finally {
    act(() => {
      setCredential(prev);
      setSettingsSection("overview");
    });
  }
});

test("pure Linux host hides DesktopSetupPrompt in overview and DesktopSettingsSection in computer details", () => {
  const prev = computersStore.get().credential;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  try {
    act(() => {
      setCredential(sampleHost());
      attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: false, setup_desktop: false }, []);
      setSettingsSection("overview");
      root!.render(createElement(SettingsContent, { withBack: false }));
    });
    expect(host.querySelector(".rd-setup-prompt")).toBeNull();

    act(() => { setSettingsSection("connection"); });
    expect(host.querySelector(".rd-settings-group")).toBeNull();
    expect(host.querySelector(".recovery-console")).toBeNull();

    // Preserves saved recovery console URL if already configured.
    act(() => {
      saveConsole(sampleHost(), "https://console.example.net/");
      window.dispatchEvent(new window.Event("pairfob-recovery-change"));
    });
    expect(host.querySelector(".rd-settings-group")).toBeNull();
    expect(host.querySelector(".recovery-console")).not.toBeNull();
  } finally {
    act(() => {
      setCredential(prev);
      setSettingsSection("overview");
    });
  }
});

test("upgraded Mac host shows setup prompt in overview and navigates to setup card in computer details", () => {
  const prev = computersStore.get().credential;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  try {
    act(() => {
      setCredential(sampleHost());
      attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: false, setup_desktop: true }, []);
      setSettingsSection("overview");
      root!.render(createElement(SettingsContent, { withBack: false }));
    });
    const prompt = host.querySelector(".rd-setup-prompt");
    expect(prompt).not.toBeNull();
    const openSetup = [...prompt!.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.textContent === t("desktop.promptOpen"),
    )!;
    act(() => { openSetup.click(); });

    expect(host.querySelector(".rd-setup-group")).not.toBeNull();
    expect(host.textContent).toContain(t("desktop.setupCommand"));
    expect(host.querySelector(".rd-setup-group .recovery-console")).not.toBeNull();
  } finally {
    act(() => {
      setCredential(prev);
      setSettingsSection("overview");
    });
  }
});
