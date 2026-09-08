import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const globals = globalThis as unknown as Record<string, unknown>;
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement",
  "HTMLFormElement", "Node", "DocumentFragment", "localStorage", "sessionStorage", "FormData"] as const) {
  globals[name] = (happy as unknown as Record<string, unknown>)[name];
}
globals.location = happy.location;
globals.matchMedia = happy.matchMedia.bind(happy);
globals.IS_REACT_ACT_ENVIRONMENT = true;
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, clearNotice, showError, showStatus, state } = await import("../../state");
const { setRenderer } = await import("../../paint");
const { setLang } = await import("../../lib/i18n");
const { renderReactScreen, leaveReactScreen } = await import("./root");
const { ConnectScreen } = await import("./connect");
const paint = () => renderReactScreen(<ConnectScreen />);

beforeEach(() => {
  setRenderer(paint);
  setLang("zh");
  state.phase = "connect";
  state.addingComputer = false;
  state.computers = [];
  state.fragment = null;
  state.pairCodeDraft = "";
  state.pairManualOpen = false;
  state.pairErrorTarget = null;
  state.pairFailedStep = null;
  state.pairAwaitingApproval = false;
  clearNotice();
});

afterEach(async () => {
  await act(() => leaveReactScreen());
  state.phase = "boot";
  clearNotice();
  setRenderer(() => {});
});

describe("React pairing", () => {
  test("first pairing and add-computer keep their respective chrome", async () => {
    await act(paint);
    expect(app.querySelector(".prelude-title")?.textContent).toBe("连上你的电脑");
    expect(app.querySelector(".topbar")).toBeNull();
    state.addingComputer = true;
    await act(paint);
    expect(app.querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect(app.querySelector(".prelude-title")).toBeNull();
    expect(app.querySelectorAll(".lang-select").length).toBe(1);
  });

  test("unrelated repaint preserves the code input, focus, and selection", async () => {
    state.pairManualOpen = true;
    state.pairCodeDraft = "ABCD-EFGH-123456";
    await act(paint);
    const input = app.querySelector<HTMLInputElement>("#pair-code")!;
    input.focus();
    input.setSelectionRange(2, 6);
    await act(paint);
    expect(app.querySelector("#pair-code")).toBe(input);
    expect(input.ownerDocument.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    expect(input.value).toBe("ABCD-EFGH-123456");
    expect(app.querySelector(".field-count")?.textContent).toBe("14/14");
  });

  test("a code error labels the input and appears only once", async () => {
    state.pairErrorTarget = "code";
    state.pairFailedStep = "code";
    showError("代码已过期", true);
    await act(paint);
    expect(app.querySelector("#pair-code")?.getAttribute("aria-describedby")).toBe("pair-feedback");
    expect(app.querySelector("#pair-code")?.getAttribute("aria-invalid")).toBe("true");
    expect(app.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(app.querySelector(".field [role='alert']")?.textContent).toBe("代码已过期");
  });

  test("channel failures belong to the progress rail", async () => {
    state.pairFailedStep = "channel";
    showError("连接暂时失败", true);
    await act(paint);
    expect(app.querySelector(".pair-step-note")?.textContent).toBe("连接暂时失败");
    expect(app.querySelector(".notice")).toBeNull();
  });

  test("notice replacement and dismissal reconcile without removing React DOM externally", async () => {
    showError("第一个错误", true);
    await act(paint);
    await act(() => { clearNotice(); showError("新的错误", true); });
    expect(app.querySelector(".notice")?.textContent).toBe("新的错误");
    await act(() => clearNotice());
    expect(app.querySelector(".notice")).toBeNull();
    await act(paint);
    expect(app.querySelector(".prelude-title")).toBeTruthy();
  });

  test("a status expires through React without disturbing the focused code field", async () => {
    state.pairManualOpen = true;
    showStatus("已准备好");
    await act(paint);
    const field = app.querySelector<HTMLInputElement>("#pair-code")!;
    field.focus();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2850)); });
    expect(app.querySelector(".notice")).toBeNull();
    expect(app.querySelector("#pair-code")).toBe(field);
    expect(field.ownerDocument.activeElement).toBe(field);
    await act(paint);
    expect(app.querySelector(".prelude")).toBeTruthy();
  });

  test("pairing and approval expose cancellation and hide submit controls", async () => {
    state.phase = "pairing";
    await act(paint);
    expect(app.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    expect(app.querySelector(".btn-connect")).toBeNull();
    expect(app.querySelector(".btn-scan")).toBeNull();
    expect(app.querySelector(".btn-ghost")?.textContent).toBe("取消");
    state.pairAwaitingApproval = true;
    await act(paint);
    expect(app.querySelectorAll('[aria-current="step"]').length).toBe(1);
    expect(app.querySelector(".pair-wait-title")?.textContent).toContain("电脑");
  });

  test("blank form submission stays local and reveals an accessible error", async () => {
    state.pairManualOpen = true;
    await act(paint);
    const event = new happy.Event("submit", { bubbles: true, cancelable: true });
    await act(() => { app.querySelector("form")!.dispatchEvent(event as unknown as Event); });
    expect(event.defaultPrevented).toBe(true);
    expect(state.phase).toBe("connect");
    expect(state.pairErrorTarget).toBe("code");
    expect(app.querySelector("#pair-code")?.getAttribute("aria-invalid")).toBe("true");
    expect(app.querySelectorAll('[role="alert"]').length).toBe(1);
  });
});
