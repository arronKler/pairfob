import { resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession, PairResult } from "../../lib/protocol/client";
import { attachLiveSession, setComputers, setCredential } from "../computers/catalog-store";
import { applyCapabilities } from "../operations/capabilities-store";
import {
  clearDesktopSetupDismissals,
  DesktopSetupPrompt,
  desktopSetupDismissKey,
  isDesktopSetupDismissed,
} from "./desktop-setup-prompt";

function sampleComputer(daemonId: string, hostname = "MacBook Pro"): PairResult {
  return {
    deviceId: "dev_test123456",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId,
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "Phone",
    createdAt: 1_700_000_000_000,
    hostname,
    lastSeen: 1_700_000_000_000,
  };
}

function fakeLiveSession(connected = true): LiveSession {
  return { isConnected: () => connected } as unknown as LiveSession;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  clearDesktopSetupDismissals();
  const comp = sampleComputer("d_mac_one_1234567890");
  setComputers([comp]);
  setCredential(comp);
  attachLiveSession(fakeLiveSession(true));
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, setup_desktop: true, view_desktop: false }, []);
});

afterEach(() => {
  act(() => unmountReact());
  clearDesktopSetupDismissals();
  attachLiveSession(null);
  setComputers([]);
  setCredential(null);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
});

test("renders null on pure Linux hosts, enabled Mac hosts, or when disconnected", () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, setup_desktop: false, view_desktop: false }, []);
  act(() => renderReact(<DesktopSetupPrompt onOpenSetup={() => {}} />));
  expect(appRoot().querySelector(".rd-setup-prompt")).toBeNull();

  act(() => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, setup_desktop: true, view_desktop: true }, []);
  });
  expect(appRoot().querySelector(".rd-setup-prompt")).toBeNull();

  act(() => {
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, setup_desktop: true, view_desktop: false }, []);
    attachLiveSession(fakeLiveSession(false));
  });
  expect(appRoot().querySelector(".rd-setup-prompt")).toBeNull();
});

test("shows discovery card without auto-focus and calls onOpenSetup on primary action", () => {
  let opened = 0;
  act(() => renderReact(<DesktopSetupPrompt onOpenSetup={() => { opened += 1; }} />));

  const card = appRoot().querySelector(".rd-setup-prompt");
  expect(card).not.toBeNull();
  expect(card?.textContent).toContain(t("desktop.promptTitle"));
  expect(card?.textContent).toContain(t("desktop.promptBody"));
  expectSameNode(document.activeElement, document.body);

  const openBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-setup-prompt button")].find(
    (btn) => btn.textContent === t("desktop.promptOpen"),
  )!;
  expect(openBtn).not.toBeNull();
  expect(openBtn.classList.contains("btn-primary")).toBeTrue();

  act(() => { openBtn.click(); });
  expect(opened).toBe(1);
});

test("dismissal persists per daemonId in localStorage without hiding other Macs", () => {
  const macA = sampleComputer("d_mac_one_1234567890", "Mac A");
  const macB = sampleComputer("d_mac_two_0987654321", "Mac B");
  setComputers([macA, macB]);
  setCredential(macA);

  act(() => renderReact(<DesktopSetupPrompt onOpenSetup={() => {}} />));
  expect(appRoot().querySelector(".rd-setup-prompt")).not.toBeNull();

  const dismissBtn = [...appRoot().querySelectorAll<HTMLButtonElement>(".rd-setup-prompt button")].find(
    (btn) => btn.textContent === t("desktop.promptDismiss"),
  )!;
  expect(dismissBtn.classList.contains("btn-ghost")).toBeTrue();

  act(() => { dismissBtn.click(); });
  expect(appRoot().querySelector(".rd-setup-prompt")).toBeNull();
  expect(isDesktopSetupDismissed(macA.daemonId)).toBeTrue();
  expect(localStorage.getItem(desktopSetupDismissKey(macA.daemonId))).toBe("1");
  expect(isDesktopSetupDismissed(macB.daemonId)).toBeFalse();

  // Switching to Mac B still offers the setup prompt.
  act(() => { setCredential(macB); });
  expect(appRoot().querySelector(".rd-setup-prompt")).not.toBeNull();

  // Switching back to Mac A keeps it dismissed.
  act(() => { setCredential(macA); });
  expect(appRoot().querySelector(".rd-setup-prompt")).toBeNull();
});
