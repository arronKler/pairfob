import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { renderConnect } = await import("./connect.ts");

function paintAdd(busy = false): void {
  state.phase = busy ? "pairing" : "connect";
  state.addingComputer = true;
  state.fragment = null;
  state.pairManualOpen = false;
  state.pairAwaitingApproval = false;
  renderConnect();
}

afterEach(() => {
  state.phase = "boot";
  state.addingComputer = false;
  state.computers = [];
  state.fragment = null;
  state.pairManualOpen = false;
  state.pairAwaitingApproval = false;
  app.replaceChildren();
});

describe("add-computer pairing chrome", () => {
  test("first-run pairing keeps the prelude, not a settings topbar", () => {
    state.phase = "connect";
    state.addingComputer = false;
    state.computers = [];
    renderConnect();
    expect(app.querySelector(".prelude")).toBeTruthy();
    expect(app.querySelector(".settings-page")).toBeNull();
    expect(app.querySelector(".topbar-title")).toBeNull();
    expect(app.querySelector(".prelude-title")?.textContent).toBe("连上你的电脑");
  });

  test("adding another computer uses the settings-page topbar", () => {
    paintAdd();
    expect(app.querySelector(".prelude")).toBeNull();
    expect(app.querySelector(".settings-page")).toBeTruthy();
    expect(app.querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect(app.querySelector(".prelude-title")).toBeNull();
    expect(app.querySelector(".back")?.getAttribute("aria-label")).toBe("返回");
    expect(app.querySelector(".btn-scan")?.textContent).toBe("扫码连接");
  });

  test("waiting for the computer still keeps the back bar", () => {
    paintAdd(true);
    expect(app.querySelector(".settings-page")).toBeTruthy();
    expect(app.querySelector(".topbar-title")?.textContent).toBe("添加另一台电脑");
    expect(app.querySelector(".pair-wait-title")?.textContent).toBe("正在验证配对码");
  });
});
