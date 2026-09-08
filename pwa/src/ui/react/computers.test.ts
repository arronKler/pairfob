import { resetTestDOM } from "../../../test-support/boot-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { PairResult } from "../../lib/protocol/client";
import { app, state } from "../../state";
import { setLang } from "../../lib/i18n";
import { createElement } from "react";
import { ComputersContent, ComputersScreen } from "./computers";
import { mount, resetRoot } from "../../../test-support/settings-render";

beforeEach(resetTestDOM);

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
  state.computers = [sampleComputer("d_0123456789abcdef0123", "desk"), sampleComputer("d_abcdef0123456789abcd", "studio")];
  mount(createElement(ComputersScreen));
}

afterEach(() => {
  state.phase = "boot";
  state.screen = "home";
  state.computers = [];
  state.addingComputer = false;
  state.credential = null;
  setLang("zh");
  resetRoot();
});

describe("computer picker", () => {
  test("the add action is a list row that carries its own hint", () => {
    paintPicker();
    const add = app.querySelector(".computer-add");
    expect(add).toBeInstanceOf(HTMLButtonElement);
    expect(add?.classList.contains("switch-item")).toBe(true);
    expect(add?.classList.contains("btn-ghost")).toBe(false);
    expect(add?.querySelector(".add-mark")).toBeTruthy();
    expect(add?.querySelector(".switch-name")?.textContent).toBe("添加另一台电脑");
    expect(add?.querySelector(".switch-meta")?.textContent).toBe("先装 pairfob 再执行 pairfob pair。只是多一条凭证，不会替换现在这台。");
    expect(app.querySelector(".computer-add + .lede")).toBeNull();
    expect(app.querySelectorAll(".computer-row")).toHaveLength(2);
    expect(app.querySelector(".prelude-title")?.textContent).toBe("选择电脑");
    expect(app.querySelector("h1.prelude-title")).toBeTruthy();
    expect(app.querySelector(".page.settings-page")).toBeNull();
    expect(app.querySelector(".computer-forget")?.getAttribute("aria-label")).toContain("desk");
    expect(app.textContent).toContain("pairfob update");
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

  test("one stored computer is an offline retry, not a multi-machine chooser", () => {
    state.phase = "pick";
    state.computers = [sampleComputer("d_0123456789abcdef0123", "desk")];
    mount(createElement(ComputersContent, { withBack: false }));
    expect(app.querySelector(".prelude-title")?.textContent).toBe("连不上电脑");
    expect(app.querySelector(".lede")?.textContent).toContain("电脑现在不在线");
    expect(app.querySelector(".topbar")).toBeNull();
  });

  test("a live session uses the settings page chrome and a back bar", () => {
    state.phase = "live";
    state.screen = "computers";
    state.computers = [sampleComputer("d_0123456789abcdef0123", "desk")];
    mount(createElement(ComputersScreen));
    expect(app.querySelector(".page.settings-page")).toBeTruthy();
    expect(app.querySelector(".topbar-title")?.textContent).toBe("电脑");
    expect(app.querySelector(".prelude-title")).toBeNull();
    expect(app.querySelector("details.set-card")).toBeNull();
  });
});
