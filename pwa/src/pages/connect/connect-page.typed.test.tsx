import { expectSameNode } from "../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { commitView } from "../../app/host";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { clearPairingFragment, phase, setPhase } from "../../features/connection/connection-store";
import { setAddingComputer, setComputers, setCredential, attachLiveSession } from "../../features/computers/catalog-store";
import {
  pairErrorTarget, pairingStore, resetPairingInput, setPairAwaitingApproval, setPairCodeDraft, setPairFailure, setPairManualOpen,
} from "../../features/pairing/form-store";
import { setScreen } from "../../app/navigation-store";
import { clearNotice, showError } from "../../app/notices-store";
import { setLang, setLangPref, t } from "../../lib/i18n";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../../features/connection/controller";
import { keepPhrases } from "../../features/pairing/phrases";

/**
 * The connect page a mouse gets below the two-column tier, against the actual
 * mounted App: one column with the steps over the code card, the same field,
 * validation and handshake the wide card has, and no scan in any stage — the
 * QR would be on this very screen. Happy DOM reports a mouse, so no pointer is
 * stubbed here. The touch page at these widths is `connect-page.test`.
 */

async function mountConnect(): Promise<void> {
  act(() => {
    mountApp();
    commitView();
  });
  // The page focuses its field in a layout effect; the action-side focus runs in a microtask.
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
}

const settle = () => act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
const field = () => appRoot().querySelector<HTMLInputElement>(".connect-card #pair-code");
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.pair-code-sheet");

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  happy.happyDOM.setWindowSize({ width: 800, height: 900 });
  registerSessionOwnerPreparer(registerSessionView);
  resetTransitionState();
  localStorage.removeItem("pairfob_lang");
  document.cookie = "pairfob_lang=;path=/;max-age=0;SameSite=Lax";
  setLangPref("auto");
  setLang("zh");
  act(() => {
    batch(() => {
      setPhase("connect");
      setScreen("home");
      setAddingComputer(false);
      setComputers([]);
      resetPairingInput();
      clearPairingFragment();
      clearNotice();
    });
  });
});

afterEach(async () => {
  await act(async () => {
    stopPolling();
    unmountApp();
    registerSessionOwnerPreparer(null);
    resetTransitionState();
    clearNotice();
    resetPairingInput();
    setAddingComputer(false);
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    setPhase("boot");
    setScreen("home");
  });
  // The next suite's reset restores the phone window.
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("a mouse in a narrow window: one column, the code typed on the page", () => {
  test("the steps, then the focused code field as the one primary control, and no scan", async () => {
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".page.connect-page.is-stacked.is-idle")).toBeTruthy();
    expect(app.querySelector(".is-wide, .connect-wide, .connect-intro")).toBeNull();
    expect(app.querySelector(".connect-top .wordmark")?.textContent).toBe("pairfob");
    expect(app.querySelectorAll(".connect-top .connect-lang select")).toHaveLength(1);
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.title"));
    expect(app.querySelector(".connect-lede")?.textContent).toBe(t("connect.ledeTyped"));
    expect([...app.querySelectorAll(".connect-step-body > b")].map(node => node.textContent))
      .toEqual([t("connect.step1"), t("connect.step2CodeBelow")]);
    expect(app.querySelector(".connect-command code")?.textContent).toBe("pairfob pair");
    expect(app.querySelector(".connect-step-note .connect-install")?.textContent).toBe(t("connect.installLink"));
    // Nothing to aim a camera at, and nothing that draws the QR to be scanned.
    expect(app.querySelector(".connect-scan")).toBeNull();
    expect(app.querySelector(".connect-manual")).toBeNull();
    expect(app.querySelector(".term-mini")).toBeNull();
    expect(app.textContent).not.toMatch(/右边/);
    expect(field()?.placeholder).toBe(t("connect.pairPlaceholder"));
    expectSameNode(document.activeElement, field());
    expect(app.querySelectorAll(".btn-primary")).toHaveLength(1);
    expect(app.querySelector(".connect-card .btn-connect")?.textContent).toBe(t("connect.submit"));
    expect(app.querySelector(".connect-card .trust")?.textContent).toBe(t("connect.trust"));
    expect(app.querySelector(".connect-phone-note")?.textContent).toBe(t("connect.phoneNote"));
    // The steps lead to the card: it comes after them in the page.
    const steps = app.querySelector(".connect-steps")!;
    expect(steps.compareDocumentPosition(field()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a phone-sized window with a mouse is the same page", async () => {
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    await mountConnect();
    expect(appRoot().querySelector(".page.connect-page.is-stacked")).toBeTruthy();
    expect(appRoot().querySelector(".connect-scan")).toBeNull();
    expectSameNode(document.activeElement, field());
  });

  test("English names the field below, never one on the right", async () => {
    setLang("en");
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".connect-lede")?.textContent).toBe(t("connect.ledeTyped"));
    expect(app.textContent).toContain("below");
    expect(app.textContent).not.toContain("on the right");
    expect(app.textContent).not.toMatch(/Scan to connect/);
  });

  test("the field is the page's own: nothing opens a sheet over it", async () => {
    act(() => { setPairManualOpen(true); setPairCodeDraft("ABCD-EFGH-JKMPQR"); });
    await mountConnect();
    expect(sheet()).toBeNull();
    expect(document.querySelectorAll("input[name=code]")).toHaveLength(1);
    expect(field()?.value).toBe("ABCD-EFGH-JKMPQR");
    expect(appRoot().querySelector(".connect-card .field-count.ok")?.textContent).toBe("14/14");
  });

  test("a blank submission stays local and marks the card's field once", async () => {
    await mountConnect();
    const form = appRoot().querySelector<HTMLFormElement>("form.connect-card")!;
    const event = new happy.Event("submit", { bubbles: true, cancelable: true });
    await act(async () => { form.dispatchEvent(event as unknown as Event); });
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(phase()).toBe("connect");
    expect(pairErrorTarget()).toBe("code");
    expect(field()?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(appRoot().querySelector(".connect-card .pair-help.is-error")).toBeTruthy();
    expect(appRoot().querySelector(".connect-lede")?.textContent).toBe(t("connect.ledeTyped"));
    expectSameNode(document.activeElement, field());
    expect(sheet()).toBeNull();
  });

  test("editing the code clears the error the last submission left under the field", async () => {
    await mountConnect();
    const form = appRoot().querySelector<HTMLFormElement>("form.connect-card")!;
    await act(async () => { form.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
    await settle();
    const input = field()!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "7k3m");
      input.setSelectionRange(4, 4);
      input.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    expectSameNode(field(), input);
    expect(pairingStore.get().pairCodeDraft).toBe("7k3m");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(appRoot().querySelector(".connect-card .pair-help.is-error")).toBeNull();
    expect(appRoot().querySelector(".connect-card #pair-feedback")?.textContent).toBe(t("connect.pairHelp"));
    expectSameNode(document.activeElement, input);
  });

  test("pasting a selected terminal line keeps only its code", async () => {
    await mountConnect();
    const paste = new happy.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "Can't scan? Type this pairing code:  7k3m-9h2p-wj3k9m\n" } });
    act(() => { field()!.dispatchEvent(paste as unknown as Event); });
    expect(paste.defaultPrevented).toBe(true);
    expect(pairingStore.get().pairCodeDraft).toBe("7K3M-9H2P-WJ3K9M");
    expect(appRoot().querySelector(".connect-card .field-count.ok")?.textContent).toBe("14/14");
  });

  test("a handshake keeps the stack: the code is shown read-only and only Cancel is offered", async () => {
    await mountConnect();
    const app = appRoot();
    await act(async () => { setPhase("pairing"); commitView(); });
    expect(app.querySelector(".page.connect-page.is-stacked.is-connecting")?.getAttribute("aria-busy")).toBe("true");
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.connectingTitle"));
    expect(app.querySelector(".connect-title .spinner")).toBeTruthy();
    expect(app.querySelectorAll(".connect-step")).toHaveLength(2);
    expect(field()?.readOnly).toBeTrue();
    expect(app.querySelector(".btn-connect")).toBeNull();
    expect(app.querySelector(".connect-card .connect-cancel")?.textContent).toBe(t("cancel"));
    await act(async () => { setPairAwaitingApproval(true); commitView(); });
    expect(app.querySelector(".page.connect-page.is-stacked.is-approve")).toBeTruthy();
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.approveTitle"));
    expect(app.querySelector(".connect-lede kbd")?.textContent).toContain("Enter");
    expect(app.querySelector(".connect-card .connect-cancel")).toBeTruthy();
    expect(app.querySelector(".connect-scan")).toBeNull();
  });

  test("a failed step lands on the title and lede and hands the keyboard back to the field", async () => {
    await mountConnect();
    const app = appRoot();
    await act(async () => { setPhase("pairing"); commitView(); });
    await act(async () => {
      setPairAwaitingApproval(false);
      setPairFailure(null, "verify");
      setPhase("connect");
      showError("电脑上没有确认。", true);
      commitView();
    });
    expect(app.querySelector(".page.connect-page.is-stacked.is-failed")).toBeTruthy();
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.failedTitle"));
    expect(app.querySelector(".connect-lede.is-error")?.textContent).toBe("电脑上没有确认。");
    expect(field()?.readOnly).toBeFalse();
    expect(field()?.getAttribute("aria-invalid")).toBeNull();
    expectSameNode(document.activeElement, field());
    expect(app.querySelector(".btn-connect")).toBeTruthy();
    expect(app.querySelector(".connect-scan")).toBeNull();
  });

  test("a failed step without its own message asks for a new code, not a scan", async () => {
    act(() => setPairFailure(null, "verify"));
    await mountConnect();
    expect(appRoot().querySelector(".connect-lede.is-error")?.textContent).toBe(keepPhrases(t("connect.failedLedeCode")));
  });

  test("adding another computer is the same page under a back bar", async () => {
    act(() => setAddingComputer(true));
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".page.connect-page.is-stacked")).toBeTruthy();
    expect(app.querySelector(".topbar-title")?.textContent).toBe(t("settings.addComputer"));
    expect(app.querySelector(".back")).toBeTruthy();
    expect(app.querySelector(".connect-lang")).toBeNull();
    expect(app.querySelector(".wordmark")).toBeNull();
    expect(app.querySelector(".connect-scan")).toBeNull();
    expectSameNode(document.activeElement, field());
  });
});
