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
import { clearPairingFragment, connectionStore, phase, setPhase } from "../../features/connection/connection-store";
import { setAddingComputer, setComputers, setCredential, attachLiveSession } from "../../features/computers/catalog-store";
import {
  setPairAwaitingApproval, setPairCodeDraft, setPairFailure, setPairManualOpen, pairManualOpen,
  pairErrorTarget, pairingStore, resetPairingInput,
} from "../../features/pairing/form-store";
import { setScreen } from "../../app/navigation-store";
import { clearNotice, showError, showStatus } from "../../app/notices-store";
import { onPairSubmit } from "../../features/pairing/actions";
import { setLang, setLangPref, t } from "../../lib/i18n";
import { resetTransitionState } from "../../app/transition";
import { stopPolling } from "../../features/connection/controller";
import { keepPhrases } from "../../features/pairing/phrases";

/**
 * The phone connect page against the actual mounted App: one skeleton (top bar,
 * terminal miniature, title + lede, bottom actions) whose stages swap copy in
 * place, the typed-code sheet (a dialog portaled to the body), add-computer
 * chrome and the compact language select — setup through the named
 * pairing/connection domains. The two-column page is `connect-page.wide.test`;
 * the one a mouse gets in a narrow window is `connect-page.typed.test`.
 */

const FINE_POINTER = "(hover: hover) and (pointer: fine)";
const realMatchMedia = happy.matchMedia;

/** Happy DOM always reports a mouse; the phone page belongs to a finger. */
function setTouchPointer(): void {
  const answer = (query: string) => query === FINE_POINTER
    ? { matches: false, media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList
    : realMatchMedia.call(happy, query);
  (happy as unknown as { matchMedia: typeof answer }).matchMedia = answer;
  (globalThis as unknown as { matchMedia: typeof answer }).matchMedia = answer;
}

async function mountConnect(): Promise<void> {
  act(() => {
    batch(() => {
      setPhase("connect");
    });
    mountApp();
    // Flush the mount-follow commit synchronously inside act so no queued
    // microtask commit renders between tests unwrapped.
    commitView();
  });
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  setTouchPointer();
  registerSessionOwnerPreparer(registerSessionView);
  resetTransitionState();
  // Reset the language preference a previous case may have pinned (the English
  // case persists 'en'); follow the browser, then force the resolved language
  // to zh so the pin does not leak into the next run.
  localStorage.removeItem("pairfob_lang");
  document.cookie = "pairfob_lang=;path=/;max-age=0;SameSite=Lax";
  setLangPref("auto");
  setLang("zh");
  act(() => {
    batch(() => {
      setPhase("connect");
      setScreen("home");
      setAddingComputer(false);
      // First-run baseline: no catalog from a prior suite (old setup cleared it
      // before the first run, not only in teardown).
      setComputers([]);
      setPairManualOpen(false);
      setPairAwaitingApproval(false);
      setPairCodeDraft("");
      // Clear a prior suite's pairing failure (field + failed step) through
      // the named action; store.reset only drops subscribers, not values.
      setPairFailure(null, null);
      // Explicitly clear any fragment a previous suite left published; the
      // connection store reset only drops subscribers, not the captured intent.
      clearPairingFragment();
      // A persistent failure notice from a prior case (the rail failure case
      // installs one) must be cleared by value, not by dropping subscribers.
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
    // Restore named owned values for the next suite (store.reset would drop
    // external subscribers, so values are cleared through their own actions):
    // persistent failure notice, pairing input, catalog/credential/session and
    // the boot/home phase baseline.
    clearNotice();
    resetPairingInput();
    setAddingComputer(false);
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    setPhase("boot");
    setScreen("home");
    // Restore the language preference this fixture may have pinned (the
    // English case persists 'en') so no other consumer reads it: follow the
    // browser, clear the stored pin and cookie, and resolve back to zh.
    await act(async () => {
      localStorage.removeItem("pairfob_lang");
      document.cookie = "pairfob_lang=;path=/;max-age=0;SameSite=Lax";
      setLangPref("auto");
      setLang("zh");
    });
  });
  // The next suite's reset re-binds the global.
  (happy as unknown as { matchMedia: typeof realMatchMedia }).matchMedia = realMatchMedia;
});

/** The code sheet is a dialog portaled to the body, outside #app. */
function sheet(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("dialog.pair-code-sheet");
}

function field(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("dialog.pair-code-sheet #pair-code");
}

test("typed draft updates keep the pair-code node without a remount", async () => {
  await mountConnect();
  act(() => setPairManualOpen(true));
  const input = field()!;
  expect(input).toBeTruthy();
  input.focus();
  input.setSelectionRange(0, 0);
  act(() => setPairCodeDraft("ABCD-EFGH-123456"));
  expectSameNode(field(), input);
  expect(input.value).toBe("ABCD-EFGH-123456");
  expect(sheet()?.querySelector(".field-count")?.textContent).toBe("14/14");
});

test("the code field keeps one input with the full-code placeholder", async () => {
  await mountConnect();
  act(() => setPairManualOpen(true));
  const input = field()!;
  expect(input.placeholder).toBe(t("connect.pairHint"));
  // Negative contract: the hand-entry field never offers the old
  // protocol-1-only eight-character hint.
  expect(input.placeholder).not.toBe("例如 7K3M-9H2P");
  expect(input.getAttribute("enterkeyhint")).toBe("go");
  expect(document.querySelectorAll("input[name=code]")).toHaveLength(1);
});

test("one skeleton: miniature, title, lede and one primary action", async () => {
  await mountConnect();
  const app = appRoot();
  expect(app.querySelector(".page.connect-page.is-idle")).toBeTruthy();
  expect(app.querySelector(".term-mini[aria-hidden=true]")).toBeTruthy();
  expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.title"));
  expect(app.querySelector(".connect-lede")?.textContent).toContain(keepPhrases(t("connect.ledeIdle")));
  expect(app.querySelectorAll(".btn-primary")).toHaveLength(1);
  expect(app.querySelector(".connect-scan")?.textContent).toBe(t("connect.scan"));
  expect(app.querySelector(".connect-manual")?.textContent).toBe(t("connect.manual"));
  expect(app.querySelector("details")).toBeNull();
  expect(sheet()).toBeNull();
  // Nothing of the spelled-out pages: their styles are not behind a width query.
  expect(app.querySelector(".is-stacked, .is-wide, .connect-steps, .connect-command, .connect-card, .connect-phone-note")).toBeNull();
  expect(app.contains(document.activeElement)).toBeFalse();
});

test("the manual action opens the code sheet; dismissing keeps the draft and its error", async () => {
  await mountConnect();
  const app = appRoot();
  await act(async () => app.querySelector<HTMLButtonElement>(".connect-manual")!.click());
  // Read the PUBLISHED snapshot: a write that skipped publication would leave
  // the sheet closed until an unrelated commit.
  expect(pairingStore.get().pairManualOpen).toBeTrue();
  expect(sheet()?.open).toBeTrue();
  expect(sheet()?.querySelector(".modal-title")?.textContent).toBe(t("connect.manual"));
  act(() => { setPairCodeDraft("ABCD"); setPairFailure("code", "code"); showError("代码不完整", true); });
  await act(async () => sheet()!.querySelector<HTMLButtonElement>(".sheet-close")!.click());
  expect(pairManualOpen()).toBeFalse();
  expect(sheet()).toBeNull();
  // A code error stays on the field: the page lede does not repeat it.
  expect(app.querySelector(".connect-lede")?.textContent).toContain(keepPhrases(t("connect.ledeIdle")));
  await act(async () => app.querySelector<HTMLButtonElement>(".connect-manual")!.click());
  expect(field()?.value).toBe("ABCD");
  expect(field()?.getAttribute("aria-invalid")).toBe("true");
  expect(sheet()?.querySelector("#pair-feedback")?.textContent).toBe("代码不完整");
});

test("adding another computer keeps the same surface under a back bar", async () => {
  act(() => setAddingComputer(true));
  await mountConnect();
  const app = appRoot();
  expect(app.querySelector(".topbar-title")?.textContent).toBe(t("settings.addComputer"));
  expect(app.querySelector(".page.connect-page")).toBeTruthy();
  expect(app.querySelector(".connect-scan")).toBeTruthy();
  expect(app.querySelector(".back")).toBeTruthy();
  expect(app.querySelector(".connect-lang")).toBeNull();
  await act(async () => { setPhase("pairing"); commitView(); });
  expect(app.querySelector(".page.connect-page.is-connecting")).toBeTruthy();
  expect(app.querySelector(".back")).toBeTruthy();
  expect(app.querySelector(".topbar-title")?.textContent).toBe(t("settings.addComputer"));
});

test("approval asks for Enter on the computer and does not mention SAS", () => {
  act(() => {
    batch(() => {
      setPhase("pairing");
      setPairAwaitingApproval(true);
    });
    mountApp();
  });
  const app = appRoot();
  expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.approveTitle"));
  expect(app.querySelector(".connect-lede kbd")?.textContent).toContain("Enter");
  // The miniature shows the chip the CLI prints at this step.
  expect(app.querySelector(".term-mini-enter")?.textContent?.trim()).toBe("Press Enter to pair");
  expect(app.textContent).not.toMatch(/SAS|安全词|两个短词|两个词/);
});

test("pairing trust copy explains the server without relay jargon", async () => {
  await mountConnect();
  const text = appRoot().textContent;
  expect(text).toContain(t("connect.trust"));
  expect(text).not.toContain("relay 服务器");
});

test("the first-run top bar carries a compact language select", async () => {
  await mountConnect();
  const app = appRoot();
  expect(app.querySelectorAll(".connect-top .connect-lang select")).toHaveLength(1);
  expect(app.querySelector(".lang-select")?.getAttribute("aria-label")).toBe(t("settings.langAria"));
  expect(app.querySelector("[role=radiogroup]")).toBeNull();
});

test("the install link opens the install help with the command", async () => {
  await mountConnect();
  await act(async () => appRoot().querySelector<HTMLButtonElement>(".connect-install")!.click());
  const help = document.querySelector<HTMLDialogElement>("dialog.help");
  expect(help?.querySelector(".modal-title")?.textContent).toBe(t("connect.installTitle"));
  expect(help?.querySelector("code")?.textContent).toBe("curl -fsSL https://pairfob.com/install.sh | sh");
  await act(async () => help!.querySelector<HTMLButtonElement>(".help-close")!.click());
});

describe("first-run connect chrome (actual App)", () => {
  test("first-run shows the wordmark, then add-computer switches to the back bar", async () => {
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".connect-top .wordmark")?.textContent).toBe("pairfob");
    expect(app.querySelector(".topbar-title")).toBeNull();
    act(() => setAddingComputer(true));
    await act(async () => { commitView(); });
    expect(app.querySelector(".topbar-title")?.textContent).toBe(t("settings.addComputer"));
    expect(app.querySelector(".connect-top")).toBeNull();
    expect(app.querySelectorAll(".lang-select")).toHaveLength(0);
  });

  test("the first-run language select switches the page copy to English", async () => {
    await mountConnect();
    const app = appRoot();
    const select = app.querySelector<HTMLSelectElement>('select[aria-label="语言"]');
    expect(select).toBeTruthy();
    expect([...select!.options].map(option => option.textContent)).toEqual(["自动", "中文", "English"]);
    act(() => {
      select!.value = "en";
      select!.dispatchEvent(new happy.Event("change", { bubbles: true }));
    });
    expect(app.querySelector(".connect-title")?.textContent).toBe("Connect your computer");
    expect(app.querySelector(".connect-scan")?.textContent).toBe("Scan to connect");
    expect(app.querySelector<HTMLSelectElement>('select[aria-label="Language"]')?.value).toBe("en");
  });
});

describe("stages and notices (actual App)", () => {
  test("connecting and approval swap copy in place and expose only Cancel", async () => {
    await mountConnect();
    const app = appRoot();
    await act(async () => { setPhase("pairing"); commitView(); });
    expect(app.querySelector(".connect-page")?.getAttribute("aria-busy")).toBe("true");
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.connectingTitle"));
    expect(app.querySelector(".connect-title .spinner")).toBeTruthy();
    expect(app.querySelector(".connect-scan")).toBeNull();
    expect(app.querySelector(".connect-manual")).toBeNull();
    expect(app.querySelector(".connect-cancel")?.textContent).toBe("取消");
    expect(app.querySelector(".term-mini-window.is-quiet")).toBeTruthy();
    await act(async () => { setPairAwaitingApproval(true); commitView(); });
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.approveTitle"));
    expect(app.querySelector(".connect-cancel")).toBeTruthy();
  });

  test.each(["channel", "verify"] as const)("a %s failure lands on the page title and lede, not a notice", async (step) => {
    await mountConnect();
    const app = appRoot();
    await act(async () => {
      setPairFailure(null, step);
      setPhase("connect");
      showError("电脑上没有确认。", true);
      commitView();
    });
    expect(app.querySelector(".page.connect-page.is-failed")).toBeTruthy();
    expect(app.querySelector(".connect-title")?.textContent).toBe(t("connect.failedTitle"));
    expect(app.querySelector(".connect-lede.is-error")?.textContent).toBe("电脑上没有确认。");
    expect(app.querySelector(".notice")).toBeNull();
    expect(app.querySelector(".connect-scan")).toBeTruthy();
    expect(sheet()).toBeNull();
  });

  test("a code error opens the sheet, labels the input and appears only once", async () => {
    await mountConnect();
    act(() => { setPairManualOpen(true); setPairFailure("code", "code"); showError("代码已过期", true); });
    await act(async () => { commitView(); });
    expect(field()?.getAttribute("aria-describedby")).toBe("pair-feedback");
    expect(field()?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(sheet()?.querySelector(".pair-help.is-error")?.textContent).toContain("代码已过期");
    expect(appRoot().textContent).not.toContain("代码已过期");
  });

  test("a page notice replaces the lede and clears back to it", async () => {
    await mountConnect();
    act(() => showError("第一个错误", true));
    await act(async () => { commitView(); });
    await act(async () => { clearNotice(); showError("新的错误", true); });
    expect(appRoot().querySelector(".connect-lede.is-error")?.textContent).toBe("新的错误");
    await act(async () => { clearNotice(); });
    expect(appRoot().querySelector(".connect-lede")?.textContent).toContain(keepPhrases(t("connect.ledeIdle")));
    expect(appRoot().querySelector(".connect-install")).toBeTruthy();
  });

  test("a status notice expires without disturbing the focused code field", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    act(() => showStatus("已准备好"));
    await act(async () => { commitView(); });
    const input = field()!;
    expect(sheet()?.querySelector("#pair-feedback")?.textContent).toBe("已准备好");
    act(() => input.focus());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2850)); });
    expect(sheet()?.querySelector("#pair-feedback")?.textContent).toBe(t("connect.pairHelp"));
    expectSameNode(field(), input);
    expectSameNode(input.ownerDocument.activeElement, input);
  });

  test("a blank submission stays local and reveals an accessible error", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    await act(async () => { commitView(); });
    // Dispatch the real form submit event so the controlled form's onSubmit runs.
    const form = sheet()!.querySelector("form")!;
    const event = new happy.Event("submit", { bubbles: true, cancelable: true });
    await act(async () => { form.dispatchEvent(event as unknown as Event); });
    expect(event.defaultPrevented).toBe(true);
    expect(phase()).toBe("connect");
    expect(pairErrorTarget()).toBe("code");
    expect(field()?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelectorAll('[role="alert"]').length).toBe(1);
  });

  test("editing the code clears the error the last submission left under the field", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    await act(async () => { commitView(); });
    const form = sheet()!.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
    const input = field()!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(sheet()?.querySelector(".pair-help.is-error")).toBeTruthy();
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "7k3m");
      input.setSelectionRange(4, 4);
      input.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    // The error described the blank submission; the sheet and its field stay.
    expectSameNode(field(), input);
    expect(pairingStore.get().pairCodeDraft).toBe("7k3m");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(sheet()?.querySelector(".pair-help.is-error")).toBeNull();
    expect(sheet()?.querySelector("#pair-feedback")?.textContent).toBe(t("connect.pairHelp"));
  });

  test("typing at the end preserves the browser's text for the input method", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    const input = field()!;
    act(() => {
      // Controlled input under happy-dom: set through the prototype so React's
      // value tracker sees the change, then follow the input with a keyup.
      input.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "7k3m9h2pwj3k9m");
      input.setSelectionRange(14, 14);
      input.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    expect(pairingStore.get().pairCodeDraft).toBe("7k3m9h2pwj3k9m");
  });
});
