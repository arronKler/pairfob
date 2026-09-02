import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";
import type { PairResult } from "../lib/protocol/client.ts";

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
const { setLang } = await import("../lib/i18n.ts");
const { renderComputers } = await import("./computers.ts");

function sampleComputer(id: string, hostname: string): PairResult {
  return {
    deviceId: "dev_abcdefgh",
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    daemonId: id,
    fp: "0".repeat(16),
    relayOrigin: "https://pairfob.com",
    label: "iPhone",
    createdAt: 1_700_000_000_000,
    hostname,
    lastSeen: 1_700_000_000_000,
  };
}

function paintPicker(): void {
  state.phase = "pick";
  state.screen = "computers";
  state.computers = [
    sampleComputer("d_0123456789abcdef0123", "desk"),
    sampleComputer("d_abcdef0123456789abcd", "studio"),
  ];
  renderComputers();
}

afterEach(() => {
  state.phase = "boot";
  state.screen = "home";
  state.computers = [];
  state.addingComputer = false;
  setLang("zh");
  app.replaceChildren();
});

describe("computer picker add row", () => {
  test("the add action is a list row that carries its own hint", () => {
    paintPicker();
    const add = app.querySelector(".computer-add");
    expect(add).toBeInstanceOf(HTMLButtonElement);
    expect(add?.classList.contains("switch-item")).toBe(true);
    expect(add?.classList.contains("btn-ghost")).toBe(false);
    expect(add?.querySelector(".add-mark")).toBeTruthy();
    expect(add?.querySelector(".switch-name")?.textContent).toBe("添加另一台电脑");
    expect(add?.querySelector(".switch-meta")?.textContent).toBe(
      "先装 pairfob 再执行 pairfob pair。只是多一条凭证，不会替换现在这台。",
    );
    expect(app.querySelector(".computer-add + .lede")).toBeNull();
    expect(app.querySelectorAll(".computer-row")).toHaveLength(2);
  });

  test("english keeps the add title and hint on the same row", () => {
    setLang("en");
    paintPicker();
    const add = app.querySelector(".computer-add");
    expect(add?.querySelector(".switch-name")?.textContent).toBe("Add another computer");
    expect(add?.querySelector(".switch-meta")?.textContent).toBe(
      "Install pairfob, then run pairfob pair. This adds a credential; it does not replace this one.",
    );
  });
});
