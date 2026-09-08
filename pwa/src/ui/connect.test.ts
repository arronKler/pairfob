import { resetTestDOM, happy } from "../../test-support/boot-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { resolveHandPairing } from "../lib/pairing-input";
import { setLang, t } from "../lib/i18n";
import { app, state, clearNotice } from "../state";
import { setRenderer } from "../paint";
import { leaveReactScreen } from "./react/root";
import { renderConnect } from "./connect";

beforeEach(async () => {
  await resetTestDOM();
  act(() => { leaveReactScreen(); clearNotice(); });
  setLang("zh");
  Object.assign(state, { phase: "connect", addingComputer: false, computers: [], fragment: null,
    pairCodeDraft: "", pairManualOpen: false, pairErrorTarget: null, pairFailedStep: null,
    pairAwaitingApproval: false });
  setRenderer(renderConnect);
});
afterEach(() => {
  act(() => { leaveReactScreen(); clearNotice(); });
  setRenderer(() => {});
  state.phase = "boot";
});
const paint = () => act(renderConnect);

describe("connect locator_required local", () => {
  test("protocol 2 incomplete entry stays on the single code field", () => {
    const result = resolveHandPairing(2, "7K3M9H2P", false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toBe("locator_required");
    expect(result.field).toBe("code");
  });

  test("protocol 1 hand entry is not a connect path", () => {
    paint();
    const input = app.querySelector<HTMLInputElement>("#pair-code")!;
    expect(input.placeholder).toBe(t("connect.pairHint"));
    expect(input.placeholder).not.toBe("例如 7K3M-9H2P");
    expect(app.querySelectorAll("input[name=code]")).toHaveLength(1);
  });

  test("adding another computer keeps the scan-first pairing surface", () => {
    state.addingComputer = true;
    paint();
    expect(app.querySelector(".topbar-title")?.textContent).toBe(t("settings.addComputer"));
    expect(app.querySelector(".lede")?.textContent).toBe(t("connect.ledeAdd"));
    expect(app.querySelector(".page.settings-page")).toBeTruthy();
    expect(app.querySelector(".btn-scan")).toBeTruthy();
    expect(app.querySelector(".back")).toBeTruthy();
    state.phase = "pairing";
    paint();
    expect(app.querySelector(".page.settings-page")).toBeTruthy();
    expect(app.querySelector(".back")).toBeTruthy();
  });

  test("QR is primary and manual entry is an accessible disclosure", () => {
    paint();
    const details = app.querySelector<HTMLDetailsElement>("details.manual-pair")!;
    expect(details.open).toBeFalse();
    expect(details.querySelector("summary")?.textContent).toContain(t("connect.manualSummary"));
    expect(app.querySelector("button.btn-scan")?.textContent).toBe(t("connect.scan"));
    expect(app.querySelector(".connect-form")?.firstElementChild?.className).toBe("btn-scan");
    expect(app.querySelector("label[for=pair-code]")?.textContent).toContain(t("connect.pairCode"));
    expect(app.textContent).not.toContain("▣");
    expect(app.querySelector(".pair-divider") === null).toBeTrue();
    act(() => { details.open = true; details.dispatchEvent(new happy.Event("toggle")); });
    expect(state.pairManualOpen).toBeTrue();
    paint();
    expect(app.querySelector("details") === details).toBeTrue();
    expect(details.open).toBeTrue();
  });

  test("waiting copy asks for Enter on the computer and does not mention SAS", () => {
    state.phase = "pairing";
    state.pairAwaitingApproval = true;
    paint();
    expect(app.textContent).toContain(t("connect.waitEnterCopy"));
    expect(app.textContent).toContain(t("connect.waitEnter"));
    expect(app.textContent).not.toMatch(/SAS|安全词|两个短词|两个词/);
  });

  test("pairing trust copy explains the server without relay jargon", () => {
    paint();
    expect(app.textContent).toContain(t("connect.trust"));
    expect(app.textContent).not.toContain("relay 服务器");
  });

  test("wide screens warn that pairing opens on the other device", () => {
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    paint();
    expect(app.querySelector(".desk-hint")?.textContent).toBe(t("connect.deskHint"));
    for (const patch of [{ addingComputer: true }, { addingComputer: false, phase: "pairing" }]) {
      Object.assign(state, patch);
      paint();
      expect(app.querySelector(".desk-hint") === null).toBeTrue();
    }
    state.phase = "connect";
    state.fragment = { v: 2, pairRef: "qa", code: "7K3M9H2P", loc: "123456" };
    paint();
    expect(app.querySelector(".desk-hint") === null).toBeTrue();
  });

  test("the pairing surface includes a compact language select", () => {
    paint();
    expect(app.querySelectorAll(".connect-lang select")).toHaveLength(1);
    expect(app.querySelector(".lang-select")?.getAttribute("aria-label")).toBe(t("settings.langAria"));
    expect(app.querySelector("[role=radiogroup]") === null).toBeTrue();
  });
});
