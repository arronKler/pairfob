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

/**
 * The connect page with room for two columns, against the actual mounted App.
 * Width gives the layout and the pointer gives the way in: a mouse types the
 * code on the page and is offered no scan; a touch screen keeps the scan and
 * the code sheet. The phone page is `connect-page.test`; a mouse in a narrow
 * window is `connect-page.typed.test`.
 */

const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const realMatchMedia = happy.matchMedia;

/** Happy DOM always reports a mouse; a tablet is the same window with a finger. */
function setPointer(fine: boolean): void {
  const answer = (query: string) => query === FINE_POINTER
    ? { matches: fine, media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList
    : realMatchMedia.call(happy, query);
  (happy as unknown as { matchMedia: typeof answer }).matchMedia = answer;
  (globalThis as unknown as { matchMedia: typeof answer }).matchMedia = answer;
}

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
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  setPointer(true);
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
  (happy as unknown as { matchMedia: typeof realMatchMedia }).matchMedia = realMatchMedia;
  // The next suite's reset re-binds the global and restores the phone window.
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("wide with a mouse: the code is typed on the page", () => {
  test("two columns: the steps on the left, the focused code field in a card, and no scan", async () => {
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".page.connect-page.is-wide.is-idle")).toBeTruthy();
    expect(app.querySelector(".connect-intro .wordmark")?.textContent).toBe("pairfob");
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.title"));
    expect(app.querySelector(".connect-lede")?.textContent).toBe(t("connect.ledeDesk"));
    expect([...app.querySelectorAll(".connect-step-body > b")].map(node => node.textContent))
      .toEqual([t("connect.step1"), t("connect.step2Code")]);
    expect(app.querySelector(".connect-command code")?.textContent).toBe("pairfob pair");
    expect(app.querySelector(".connect-phone-note")?.textContent).toBe(t("connect.phoneNote"));
    // The QR to scan would be on this very screen.
    expect(app.querySelector(".connect-scan")).toBeNull();
    expect(app.querySelector(".connect-manual")).toBeNull();
    expect(app.querySelector(".term-mini")).toBeNull();
    expect(field()?.placeholder).toBe(t("connect.pairPlaceholder"));
    expectSameNode(document.activeElement, field());
    expect(app.querySelectorAll(".btn-primary")).toHaveLength(1);
    expect(app.querySelector(".connect-card .btn-connect")?.textContent).toBe(t("connect.submit"));
    expect(app.querySelector(".connect-card .trust")?.textContent).toBe(t("connect.trust"));
    expect(app.querySelectorAll(".connect-top .connect-lang select")).toHaveLength(1);
    expect(app.textContent).not.toMatch(/手机上打开/);
  });

  test("the field is the page's own: nothing opens a sheet over it", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    expect(sheet()).toBeNull();
    expect(document.querySelectorAll("input[name=code]")).toHaveLength(1);
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
    // The page lede does not repeat a field error, and the keyboard is back on the field.
    expect(appRoot().querySelector(".connect-lede")?.textContent).toBe(t("connect.ledeDesk"));
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
    // Anything that is not one whole code is the field's own business.
    const words = new happy.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(words, "clipboardData", { value: { getData: () => "hello" } });
    act(() => { field()!.dispatchEvent(words as unknown as Event); });
    expect(words.defaultPrevented).toBe(false);
    expect(pairingStore.get().pairCodeDraft).toBe("7K3M-9H2P-WJ3K9M");
  });

  test("the command copies in one click and says so", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { written.push(text); } }, configurable: true });
    await mountConnect();
    const copy = appRoot().querySelector<HTMLButtonElement>(".connect-command-copy")!;
    expect(copy.textContent).toBe(t("empty.copy"));
    await act(async () => copy.click());
    expect(written).toEqual(["pairfob pair"]);
    expect(copy.textContent).toBe(t("empty.copied"));
  });

  test("a handshake keeps both columns: the code is shown read-only and only Cancel is offered", async () => {
    await mountConnect();
    const app = appRoot();
    await act(async () => { setPhase("pairing"); commitView(); });
    expect(app.querySelector(".page.connect-page.is-wide.is-connecting")?.getAttribute("aria-busy")).toBe("true");
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.connectingTitle"));
    expect(app.querySelector(".connect-title .spinner")).toBeTruthy();
    expect(app.querySelectorAll(".connect-step")).toHaveLength(2);
    expect(field()?.readOnly).toBeTrue();
    expect(app.querySelector(".btn-connect")).toBeNull();
    expect(app.querySelector(".connect-card .connect-cancel")?.textContent).toBe(t("cancel"));
    await act(async () => { setPairAwaitingApproval(true); commitView(); });
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.approveTitle"));
    expect(app.querySelector(".connect-lede kbd")?.textContent).toContain("Enter");
    expect(app.querySelector(".connect-card .connect-cancel")).toBeTruthy();
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
    expect(app.querySelector(".page.connect-page.is-wide.is-failed")).toBeTruthy();
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.failedTitle"));
    expect(app.querySelector(".connect-lede.is-error")?.textContent).toBe("电脑上没有确认。");
    expect(field()?.readOnly).toBeFalse();
    expect(field()?.getAttribute("aria-invalid")).toBeNull();
    expectSameNode(document.activeElement, field());
    expect(app.querySelector(".btn-connect")).toBeTruthy();
    expect(app.querySelector(".connect-scan")).toBeNull();
  });

  test("adding another computer is the same page under a back bar", async () => {
    act(() => setAddingComputer(true));
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".topbar-title")?.textContent).toBe(t("settings.addComputer"));
    expect(app.querySelector(".back")).toBeTruthy();
    expect(app.querySelector(".connect-lang")).toBeNull();
    expect(app.querySelector(".connect-intro .wordmark")).toBeNull();
    expect(app.querySelector(".connect-lede")?.textContent).toBe(t("connect.ledeDesk"));
    expectSameNode(document.activeElement, field());
  });
});

describe("wide with a touch screen: the camera stays the way in", () => {
  beforeEach(() => setPointer(false));

  test("two columns with the miniature and the scan; nothing takes the focus", async () => {
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".page.connect-page.is-wide.is-idle")).toBeTruthy();
    expect(app.querySelector(".connect-lede")?.textContent).toBe(t("connect.ledeWideScan"));
    expect([...app.querySelectorAll(".connect-step-body > b")].map(node => node.textContent))
      .toEqual([t("connect.step1"), t("connect.step2Scan")]);
    expect(app.querySelector(".connect-side .term-mini[aria-hidden=true]")).toBeTruthy();
    expect(app.querySelectorAll(".btn-primary")).toHaveLength(1);
    expect(app.querySelector(".connect-side .connect-scan")?.textContent).toBe(t("connect.scan"));
    expect(app.querySelector(".connect-side .connect-manual")?.textContent).toBe(t("connect.manual"));
    expect(app.querySelector(".connect-card")).toBeNull();
    expect(app.querySelector(".connect-phone-note")).toBeNull();
    expect(app.contains(document.activeElement)).toBeFalse();
  });

  test("the typed code is the second path, in the sheet", async () => {
    await mountConnect();
    await act(async () => appRoot().querySelector<HTMLButtonElement>(".connect-manual")!.click());
    expect(pairingStore.get().pairManualOpen).toBeTrue();
    expect(sheet()?.open).toBeTrue();
    expect(sheet()?.querySelector<HTMLInputElement>("#pair-code")?.placeholder).toBe(t("connect.pairHint"));
    expect(sheet()?.querySelector(".pair-paste")).toBeTruthy();
  });

  test("a handshake keeps the miniature and leaves only Cancel", async () => {
    await mountConnect();
    const app = appRoot();
    await act(async () => { setPhase("pairing"); setPairAwaitingApproval(true); commitView(); });
    expect(app.querySelector(".page.connect-page.is-wide.is-approve")).toBeTruthy();
    expect(app.querySelector(".connect-side .term-mini-enter")?.textContent?.trim()).toBe("Press Enter to pair");
    expect(app.querySelector(".connect-scan")).toBeNull();
    expect(app.querySelector(".connect-side .connect-cancel")).toBeTruthy();
  });
});

describe("the layout follows the window", () => {
  test("crossing the breakpoint with a finger swaps the phone page for the two columns; the scan stays", async () => {
    setPointer(false);
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".page.connect-page.is-wide")).toBeNull();
    expect(app.querySelector(".term-mini")).toBeTruthy();
    expect(app.querySelector(".connect-steps")).toBeNull();
    expect(app.querySelector(".connect-scan")).toBeTruthy();
    await act(async () => { happy.happyDOM.setWindowSize({ width: 1440, height: 900 }); });
    await settle();
    expect(app.querySelector(".page.connect-page.is-wide")).toBeTruthy();
    expect(app.querySelector(".connect-side .connect-scan")).toBeTruthy();
    expect(app.querySelector(".connect-steps")).toBeTruthy();
  });

  test("crossing it with a mouse moves the same field from one column to two; no scan on either side", async () => {
    happy.happyDOM.setWindowSize({ width: 800, height: 900 });
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".page.connect-page.is-stacked")).toBeTruthy();
    expect(app.querySelector(".connect-scan")).toBeNull();
    expectSameNode(document.activeElement, field());
    act(() => setPairCodeDraft("7K3M-9H2P"));
    await act(async () => { happy.happyDOM.setWindowSize({ width: 1440, height: 900 }); });
    await settle();
    expect(app.querySelector(".page.connect-page.is-wide")).toBeTruthy();
    expect(app.querySelector(".is-stacked")).toBeNull();
    expect(app.querySelector(".connect-scan")).toBeNull();
    // The draft is the pairing domain's, so the wider page's field carries it on.
    expect(field()?.value).toBe("7K3M-9H2P");
  });
});
