import { resetBoardTestDOM } from "../../../test-support/dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { PairResult } from "../../lib/protocol/client";
import { forgetConsole, saveConsole } from "../../lib/recovery-console";
import { setComputers, setCredential } from "../computers/catalog-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { DESKTOP_PREFS_KEY, getDesktopPrefs, setDefaultAudio, setDefaultMode, setDefaultQuality } from "./desktop-prefs";
import { DesktopSettingsSection } from "./desktop-settings-section";

function sampleComputer(): PairResult {
  return {
    deviceId: "dev_test123456",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: "d_test12345678901234",
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "Phone",
    createdAt: 1_700_000_000_000,
    hostname: "MacBook Pro",
    lastSeen: 1_700_000_000_000,
  };
}

let savedClipboard: Clipboard | undefined;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  localStorage.removeItem(DESKTOP_PREFS_KEY);
  const comp = sampleComputer();
  forgetConsole(comp.daemonId);
  setDefaultMode("control");
  setDefaultQuality("balanced");
  setDefaultAudio(false);
  setComputers([comp]);
  setCredential(comp);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: true, control_desktop: true, listen_desktop_audio: false }, []);
  savedClipboard = navigator.clipboard;
});

afterEach(() => {
  act(() => unmountReact());
  localStorage.removeItem(DESKTOP_PREFS_KEY);
  forgetConsole("d_test12345678901234");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: savedClipboard });
  setComputers([]);
  setCredential(null);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
});

test("renders null on pure Linux hosts without view_desktop or setup_desktop when no console URL is saved", () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: false, setup_desktop: false }, []);
  act(() => renderReact(<DesktopSettingsSection connected onOpenDesktop={() => {}} />));
  expect(appRoot().innerHTML).toBe("");
  expect(appRoot().querySelector(".rd-settings-group")).toBeNull();
  expect(appRoot().querySelector("details.recovery-console")).toBeNull();
});

test("preserves RecoveryConsole on pure Linux hosts if user already saved a console URL", () => {
  const comp = sampleComputer();
  saveConsole(comp, "https://console.example.net/");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: false, setup_desktop: false }, []);
  act(() => renderReact(<DesktopSettingsSection connected onOpenDesktop={() => {}} />));

  expect(appRoot().querySelector(".rd-settings-group")).toBeNull();
  expect(appRoot().querySelector("details.recovery-console")).not.toBeNull();
  expect(appRoot().textContent).toContain(t("recovery.title"));
  expect(appRoot().textContent).not.toContain(t("desktop.openDesktop"));
  expect(appRoot().textContent).not.toContain(t("desktop.setupTitle"));
});

test("renders setup card with copyable command and RecoveryConsole when setup_desktop is true and view_desktop is false", async () => {
  const copiedTexts: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => { copiedTexts.push(text); },
    },
  });
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: false, setup_desktop: true }, []);
  act(() => renderReact(<DesktopSettingsSection connected onOpenDesktop={() => {}} />));

  expect(appRoot().querySelector(".rd-setup-group")).not.toBeNull();
  expect(appRoot().textContent).toContain(t("desktop.setupTitle"));
  expect(appRoot().textContent).toContain(t("desktop.setupCommand"));
  expect(appRoot().textContent).toContain(t("desktop.setupNote"));
  expect(appRoot().querySelector("details.recovery-console")).not.toBeNull();

  // Never show disabled toggles or Open desktop button in setup state.
  expect(appRoot().querySelector('[role="switch"]')).toBeNull();
  expect(appRoot().querySelector('[role="radio"]')).toBeNull();
  expect(appRoot().textContent).not.toContain(t("desktop.openDesktop"));

  const copyBtn = appRoot().querySelector<HTMLButtonElement>(".rd-copy-btn")!;
  expect(copyBtn).not.toBeNull();
  await act(async () => {
    copyBtn.click();
    await Promise.resolve();
  });
  expect(copiedTexts).toEqual([t("desktop.setupCommand")]);
  expect(copyBtn.querySelector(".copy-ack")?.getAttribute("data-state")).toBe("copied");
  expect(copyBtn.querySelector('.copy-ack-face[aria-hidden="false"]')?.textContent).toBe(t("desktop.copied"));
});

test("renders capability badges reflecting view/control/audio grants when view_desktop is enabled", () => {
  act(() => renderReact(<DesktopSettingsSection connected onOpenDesktop={() => {}} />));
  const tags = [...appRoot().querySelectorAll(".rd-cap-strip .set-tag")];
  expect(tags).toHaveLength(3);
  expect(tags[0].textContent).toBe(t("desktop.capView"));
  expect(tags[0].classList.contains("is-ok")).toBeTrue();
  expect(tags[1].textContent).toBe(t("desktop.capControl"));
  expect(tags[1].classList.contains("is-ok")).toBeTrue();
  expect(tags[2].textContent).toBe(t("desktop.capAudio"));
  expect(tags[2].classList.contains("is-ok")).toBeFalse();

  act(() => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, view_desktop: true, control_desktop: false, listen_desktop_audio: true }, []);
  });
  const updated = [...appRoot().querySelectorAll(".rd-cap-strip .set-tag")];
  expect(updated[1].classList.contains("is-ok")).toBeFalse();
  expect(updated[2].classList.contains("is-ok")).toBeTrue();
});

test("persists default mode, quality, and audio preferences to localStorage", () => {
  act(() => renderReact(<DesktopSettingsSection connected onOpenDesktop={() => {}} />));

  const viewRadio = [...appRoot().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (btn) => btn.textContent === t("desktop.modeViewShort"),
  )!;
  const detailRadio = [...appRoot().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (btn) => btn.textContent === t("desktop.detail"),
  )!;
  const audioSwitch = appRoot().querySelector<HTMLButtonElement>('[role="switch"]')!;

  expect(viewRadio.getAttribute("aria-checked")).toBe("false");
  expect(detailRadio.getAttribute("aria-checked")).toBe("false");
  expect(audioSwitch.getAttribute("aria-checked")).toBe("false");

  act(() => { viewRadio.click(); });
  act(() => { detailRadio.click(); });
  act(() => { audioSwitch.click(); });

  expect(viewRadio.getAttribute("aria-checked")).toBe("true");
  expect(detailRadio.getAttribute("aria-checked")).toBe("true");
  expect(audioSwitch.getAttribute("aria-checked")).toBe("true");

  expect(getDesktopPrefs()).toEqual({
    defaultMode: "view",
    defaultQuality: "detail",
    defaultAudio: true,
    touchMode: "trackpad",
  });
  const stored = JSON.parse(localStorage.getItem(DESKTOP_PREFS_KEY) ?? "{}");
  expect(stored.defaultMode).toBe("view");
  expect(stored.defaultQuality).toBe("detail");
  expect(stored.defaultAudio).toBeTrue();
});

test("embeds RecoveryConsole and triggers onOpenDesktop only when connected", () => {
  let opens = 0;
  act(() => renderReact(<DesktopSettingsSection connected={false} onOpenDesktop={() => { opens += 1; }} />));

  const openBtn = [...appRoot().querySelectorAll<HTMLButtonElement>("button")].find(
    (btn) => btn.textContent?.includes(t("desktop.openDesktop")),
  )!;
  expect(openBtn).toBeTruthy();
  expect(openBtn.disabled).toBeTrue();
  expect(appRoot().querySelector("details.recovery-console")).not.toBeNull();

  act(() => { openBtn.click(); });
  expect(opens).toBe(0);

  act(() => renderReact(<DesktopSettingsSection connected onOpenDesktop={() => { opens += 1; }} />));
  const enabledBtn = [...appRoot().querySelectorAll<HTMLButtonElement>("button")].find(
    (btn) => btn.textContent?.includes(t("desktop.openDesktop")),
  )!;
  expect(enabledBtn.disabled).toBeFalse();
  act(() => { enabledBtn.click(); });
  expect(opens).toBe(1);
});
