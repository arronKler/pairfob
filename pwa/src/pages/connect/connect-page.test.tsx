import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { batch } from "../../shared/model/domain-store";
import { mountApp, unmountApp } from "../../app/mount";
import { commitView } from "../../app/host";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../../features/session/register";
import { applyPairingFragment, clearPairingFragment, connectionStore, phase, setPhase } from "../../features/connection/connection-store";
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

/**
 * Connect surface against the actual mounted App. Migrated from the former
 * ui/connect facade fixture: scan-first surface, add-computer chrome, manual
 * disclosure, waiting copy, trust copy, wide-screen hint and the compact
 * language select — setup through the named pairing/connection domains.
 */

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
});

test("typed draft updates keep the pair-code node without a root remount", async () => {
  await mountConnect();
  const app = appRoot();
  act(() => setPairManualOpen(true));
  const input = app.querySelector<HTMLInputElement>("#pair-code")!;
  expect(input).toBeTruthy();
  input.focus();
  input.setSelectionRange(0, 0);
  act(() => setPairCodeDraft("ABCD-EFGH-123456"));
  expect(app.querySelector("#pair-code")).toBe(input);
  expect(input.value).toBe("ABCD-EFGH-123456");
  expect(app.querySelector(".field-count")?.textContent).toBe("14/14");
});

test("the hand entry keeps one code field with the scan-first placeholder", async () => {
  await mountConnect();
  const app = appRoot();
  act(() => setPairManualOpen(true));
  const input = app.querySelector<HTMLInputElement>("#pair-code")!;
  expect(input.placeholder).toBe(t("connect.pairHint"));
  // Negative contract: the hand-entry field never offers the old
  // protocol-1-only eight-character hint (the complete-code locator is the
  // scan/QR path). A mistaken translation back to that 8-char-only hint would
  // pass the positive equality above, so this guard is kept.
  expect(input.placeholder).not.toBe("例如 7K3M-9H2P");
  expect(app.querySelectorAll("input[name=code]")).toHaveLength(1);
});

test("adding another computer keeps the scan-first pairing surface", async () => {
  act(() => setAddingComputer(true));
  await mountConnect();
  const app = appRoot();
  expect(app.querySelector(".topbar-title")?.textContent).toBe(t("settings.addComputer"));
  expect(app.querySelector(".lede")?.textContent).toBe(t("connect.ledeAdd"));
  expect(app.querySelector(".page.settings-page")).toBeTruthy();
  expect(app.querySelector(".btn-scan")).toBeTruthy();
  expect(app.querySelector(".back")).toBeTruthy();
  // A staged phase change renders via the queued commit; flush it inside act.
  await act(async () => { setPhase("pairing"); commitView(); });
  expect(app.querySelector(".page.settings-page")).toBeTruthy();
  expect(app.querySelector(".back")).toBeTruthy();
});

test("QR is primary and manual entry is an accessible disclosure", async () => {
  await mountConnect();
  const app = appRoot();
  const details = app.querySelector<HTMLDetailsElement>("details.manual-pair")!;
  expect(details.open).toBeFalse();
  expect(details.querySelector("summary")?.textContent).toContain(t("connect.manualSummary"));
  expect(app.querySelector("button.btn-scan")?.textContent).toBe(t("connect.scan"));
  expect(app.querySelector(".connect-form")?.firstElementChild?.className).toBe("btn-scan");
  expect(app.querySelector("label[for=pair-code]")?.textContent).toContain(t("connect.pairCode"));
  expect(app.textContent).not.toContain("▣");
  expect(app.querySelector(".pair-divider")).toBeNull();
  act(() => { details.open = true; details.dispatchEvent(new happy.Event("toggle")); });
  // The toggle publishes the pairing domain's manual-open state. Read the
  // PUBLISHED snapshot (not only the canonical getter): a stale write that set
  // the canonical value without publishing would leave this false until commit.
  expect(pairingStore.get().pairManualOpen).toBeTrue();
  expect(pairManualOpen()).toBeTrue();
  // ...and the subsequent commit preserves the SAME details node, now open.
  await act(async () => { commitView(); });
  expect(app.querySelector("details") === details).toBeTrue();
  expect(details.open).toBeTrue();
});

test("waiting copy asks for Enter on the computer and does not mention SAS", () => {
  // Phase/awaiting state is a composition change; publish it headless before
  // mounting so the mounted connect surface renders the pairing wait.
  act(() => {
    batch(() => {
      setPhase("pairing");
      setPairAwaitingApproval(true);
    });
    mountApp();
  });
  const text = appRoot().textContent;
  expect(text).toContain(t("connect.waitEnterCopy"));
  expect(text).toContain(t("connect.waitEnter"));
  expect(text).not.toMatch(/SAS|安全词|两个短词|两个词/);
});

test("pairing trust copy explains the server without relay jargon", async () => {
  await mountConnect();
  const text = appRoot().textContent;
  expect(text).toContain(t("connect.trust"));
  expect(text).not.toContain("relay 服务器");
});

test("wide screens warn that pairing opens on the other device", async () => {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  await mountConnect();
  expect(appRoot().querySelector(".desk-hint")?.textContent).toBe(t("connect.deskHint"));
  await act(async () => { setAddingComputer(true); commitView(); });
  expect(appRoot().querySelector(".desk-hint")).toBeNull();
  // Adding is cleared before pairing: the pairing/busy branch must hide the
  // hint independently of the add-computer branch.
  await act(async () => { setAddingComputer(false); setPhase("pairing"); commitView(); });
  expect(appRoot().querySelector(".desk-hint")).toBeNull();
  // A scanned (QR) connect intent on a wide screen also opens on the phone,
  // not the desk surface.
  await act(async () => {
    setPhase("connect");
    setAddingComputer(false);
    applyPairingFragment({ v: 2, pairRef: "qa", code: "7K3M9H2P", loc: "123456" });
    commitView();
  });
  expect(appRoot().querySelector(".desk-hint")).toBeNull();
});
test("the pairing surface includes a compact language select", async () => {
  await mountConnect();
  const app = appRoot();
  expect(app.querySelectorAll(".connect-lang select")).toHaveLength(1);
  expect(app.querySelector(".lang-select")?.getAttribute("aria-label")).toBe(t("settings.langAria"));
  expect(app.querySelector("[role=radiogroup]")).toBeNull();
});

describe("add-computer pairing chrome (actual App)", () => {
  async function mountAdd(busy = false): Promise<void> {
    act(() => {
      batch(() => {
        setPhase(busy ? "pairing" : "connect");
        setAddingComputer(true);
        setPairManualOpen(false);
        setPairAwaitingApproval(false);
        setPairFailure(null, null);
      });
      mountApp();
    });
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }

  test("adding another computer uses the settings-page topbar, first-run keeps the prelude", async () => {
    await mountAdd();
    const app = appRoot();
    expect(app.querySelector(".prelude")).toBeNull();
    expect(app.querySelector(".page.settings-page")).toBeTruthy();
    expect(app.querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect(app.querySelector(".prelude-title")).toBeNull();
    expect(app.querySelector(".back")?.getAttribute("aria-label")).toBe("返回");
    expect(app.querySelector(".btn-scan")?.textContent).toBe("扫码连接");
  });

  test("waiting for the computer still keeps the back bar", async () => {
    await mountAdd(true);
    expect(appRoot().querySelector(".page.settings-page")).toBeTruthy();
    expect(appRoot().querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect(appRoot().querySelector(".pair-wait-title")?.textContent).toBe("正在验证配对码");
  });

  test("the rail marks the step pairing is on, awaiting, and the step it died on", async () => {
    await mountAdd(true);
    const states = () => [...appRoot().querySelectorAll(".pair-step")].map((step) => step.className);
    expect(states()).toEqual(["pair-step is-done", "pair-step is-active", "pair-step is-todo"]);
    await act(async () => { setPairAwaitingApproval(true); });
    expect(states()).toEqual(["pair-step is-done", "pair-step is-done", "pair-step is-active"]);
    // A failure freezes the rail on the step that failed; the phase is back to
    // connect (the landing) with the verify step frozen, and the same sentence
    // does not also appear as a standalone notice.
    await act(async () => {
      setPairAwaitingApproval(false);
      setPairFailure(null, "verify");
      setPhase("connect");
      showError("电脑上没有确认。", true);
      commitView();
    });
    expect(states()).toEqual(["pair-step is-done", "pair-step is-done", "pair-step is-failed"]);
    expect(appRoot().querySelector(".pair-step-note")?.textContent).toBe("电脑上没有确认。");
    expect(appRoot().querySelector(".notice-error")).toBeNull();
  });

  test("a channel failure while the channel step is active freezes its note on the rail", async () => {
    await mountAdd(true);
    // The channel step is active before approval; failing there freezes the
    // channel cell, not a standalone notice.
    await act(async () => {
      setPairFailure(null, "channel");
      setPhase("connect");
      showError("连接暂时失败", true);
      commitView();
    });
    expect([...appRoot().querySelectorAll(".pair-step")].map(s => s.className)).toEqual([
      "pair-step is-done", "pair-step is-failed", "pair-step is-todo",
    ]);
    expect(appRoot().querySelector(".pair-step-note")?.textContent).toBe("连接暂时失败");
    expect(appRoot().querySelector(".notice")).toBeNull();
  });

  test("adding another computer puts language in the topbar, not the prelude footer", async () => {
    await mountAdd();
    const lang = appRoot().querySelector(".connect-lang");
    expect(Boolean(lang)).toBe(true);
    expect(appRoot().querySelector(".topbar")?.contains(lang!)).toBeTrue();
    // The trust note renders, but in add-chrome nothing follows it (the compact
    // language select lives in the topbar, no full radio segment).
    const trust = appRoot().querySelector(".trust");
    expect(trust?.nextElementSibling).toBeNull();
    expect(appRoot().querySelector(".seg")).toBeNull();
  });
});

describe("first-run connect chrome (actual App)", () => {
  test("first-run pairing keeps the prelude, then add-computer switches to the settings topbar", async () => {
    // First-run: no add-computer flow, empty catalog, on the same narrow root.
    await mountConnect();
    const app = appRoot();
    expect(app.querySelector(".prelude")).toBeTruthy();
    expect(app.querySelector(".page.settings-page")).toBeNull();
    expect(app.querySelector(".topbar-title")).toBeNull();
    expect(app.querySelector(".prelude-title")?.textContent).toBe("连上你的电脑");
    // Engaging add-computer on that SAME mounted root swaps the prelude for
    // the settings topbar and keeps exactly one language select.
    act(() => setAddingComputer(true));
    await act(async () => { commitView(); });
    expect(app.querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect(app.querySelector(".prelude-title")).toBeNull();
    expect(app.querySelectorAll(".lang-select")).toHaveLength(1);
  });

  test("the first-run language select switches the page copy to English", async () => {
    await mountConnect();
    const app = appRoot();
    const select = app.querySelector<HTMLSelectElement>('select[aria-label="语言"]');
    expect(select).toBeTruthy();
    expect([...select!.options].map(option => option.textContent)).toEqual(["自动", "中文", "English"]);
    // The language select lives in the prelude footer, after the trust note.
    expect(app.querySelector(".trust")?.nextElementSibling).toBe(app.querySelector(".connect-lang"));
    act(() => {
      select!.value = "en";
      select!.dispatchEvent(new happy.Event("change", { bubbles: true }));
    });
    expect(app.querySelector(".prelude-title")?.textContent).toBe("Connect your computer");
    expect(app.querySelector(".btn-scan")?.textContent).toBe("Scan to connect");
    expect(app.querySelector<HTMLSelectElement>('select[aria-label="Language"]')?.value).toBe("en");
  });
});

describe("pairing form error/notice/focus behavior (actual App)", () => {
  test("unrelated re-render preserves the code input value, focus and selection", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    act(() => setPairCodeDraft("ABCD-EFGH-123456"));
    await act(async () => { commitView(); });
    const input = appRoot().querySelector<HTMLInputElement>("#pair-code")!;
    act(() => input.focus());
    act(() => input.setSelectionRange(2, 6));
    // An unrelated commit keeps the same node, focus, selection and value.
    await act(async () => { commitView(); });
    expect(appRoot().querySelector("#pair-code")).toBe(input);
    expect(input.ownerDocument.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    expect(input.value).toBe("ABCD-EFGH-123456");
    expect(appRoot().querySelector(".field-count")?.textContent).toBe("14/14");
  });

  test("a code error labels the input and appears only once", async () => {
    // The manual field is closed; only the code error makes the input visible.
    await mountConnect();
    act(() => { setPairFailure("code", "code"); showError("代码已过期", true); });
    await act(async () => { commitView(); });
    expect(appRoot().querySelector("#pair-code")?.getAttribute("aria-describedby")).toBe("pair-feedback");
    expect(appRoot().querySelector("#pair-code")?.getAttribute("aria-invalid")).toBe("true");
    expect(appRoot().querySelectorAll('[role="alert"]').length).toBe(1);
    expect(appRoot().querySelector(".field [role='alert']")?.textContent).toBe("代码已过期");
  });

  test("notice replacement and dismissal reconcile through the mounted notice", async () => {
    await mountConnect();
    act(() => showError("第一个错误", true));
    await act(async () => { commitView(); });
    await act(async () => { clearNotice(); showError("新的错误", true); });
    expect(appRoot().querySelector(".notice")?.textContent).toBe("新的错误");
    await act(async () => { clearNotice(); });
    expect(appRoot().querySelector(".notice")).toBeNull();
    // After dismissal the connect prelude still renders.
    await act(async () => { commitView(); });
    expect(appRoot().querySelector(".prelude-title")).toBeTruthy();
  });

  test("a status notice expires without disturbing the focused code field", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    act(() => showStatus("已准备好"));
    await act(async () => { commitView(); });
    const field = appRoot().querySelector<HTMLInputElement>("#pair-code")!;
    act(() => field.focus());
    // The status auto-dismisses after 2800ms; the field keeps focus/node.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2850)); });
    expect(appRoot().querySelector(".notice")).toBeNull();
    expect(appRoot().querySelector("#pair-code")).toBe(field);
    expect(field.ownerDocument.activeElement).toBe(field);
    // The prelude still renders after the notice clears.
    await act(async () => { commitView(); });
    expect(appRoot().querySelector(".prelude")).toBeTruthy();
  });

  test("pairing and approval expose cancellation and hide submit controls", async () => {
    await mountConnect();
    await act(async () => { setPhase("pairing"); commitView(); });
    expect(appRoot().querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    expect(appRoot().querySelector(".btn-connect")).toBeNull();
    expect(appRoot().querySelector(".btn-scan")).toBeNull();
    expect(appRoot().querySelector(".btn-ghost")?.textContent).toBe("取消");
    await act(async () => { setPairAwaitingApproval(true); commitView(); });
    expect(appRoot().querySelectorAll('[aria-current="step"]').length).toBe(1);
    expect(appRoot().querySelector(".pair-wait-title")?.textContent).toContain("电脑");
  });

  test("a channel failure on the first-run pairing entry freezes its note on the rail", async () => {
    // First-run (no add-computer, no scanned fragment): a channel failure lands
    // back to connect with the channel step frozen; its note goes on the
    // progress rail, not a standalone notice.
    await mountConnect();
    await act(async () => {
      setPairFailure(null, "channel");
      setPhase("connect");
      showError("连接暂时失败", true);
      commitView();
    });
    expect([...appRoot().querySelectorAll(".pair-step")].map(s => s.className)).toEqual([
      "pair-step is-done", "pair-step is-failed", "pair-step is-todo",
    ]);
    expect(appRoot().querySelector(".pair-step-note")?.textContent).toBe("连接暂时失败");
    expect(appRoot().querySelector(".notice")).toBeNull();
  });

  test("a blank form submission stays local and reveals an accessible error", async () => {
    await mountConnect();
    act(() => setPairManualOpen(true));
    await act(async () => { commitView(); });
    // Dispatch the real form submit event (the form's React onSubmit handler
    // runs onPairSubmit through the controlled form); no direct controller call.
    const form = appRoot().querySelector("form")!;
    const event = new happy.Event("submit", { bubbles: true, cancelable: true });
    await act(async () => { form.dispatchEvent(event as unknown as Event); });
    expect(event.defaultPrevented).toBe(true);
    expect(phase()).toBe("connect");
    expect(pairErrorTarget()).toBe("code");
    expect(appRoot().querySelector("#pair-code")?.getAttribute("aria-invalid")).toBe("true");
    expect(appRoot().querySelectorAll('[role="alert"]').length).toBe(1);
  });
});
