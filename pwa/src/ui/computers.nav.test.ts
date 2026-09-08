import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { act } from "react";
import { leaveReactScreen } from "./react/root";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PairResult } from "../lib/protocol/client.ts";

const { setRenderer } = await import("../paint.ts");
const { app, state } = await import("../state.ts");
const { setLang } = await import("../lib/i18n.ts");
const { renderComputers: paintComputers } = await import("./computers.ts");

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

function renderComputers(): void { act(paintComputers); }

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  Object.assign(state, { phase: "live", screen: "home", fullTerminal: false, agentChat: false,
    credential: null, live: null, computers: [], agents: [], paneId: "", panePinned: {}, paneTouched: {},
    listGroup: "flat", listGroupCollapsed: {}, operationBusy: false, networkOnline: true, runtimeKind: "herdr",
    herdHost: "", notice: null, settingsLoading: false, deviceList: [], devicesError: "", pushConfigError: "",
    pushEnabled: null, pushSubscribed: null });
  setLang("zh");
});

afterEach(() => {
  act(() => leaveReactScreen());
  setRenderer(() => {});
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
    expect((add) instanceof HTMLButtonElement).toBe(true);
    expect(add?.classList.contains("switch-item")).toBe(true);
    expect(add?.classList.contains("btn-ghost")).toBe(false);
    expect(Boolean(add?.querySelector(".add-mark"))).toBe(true);
    expect(add?.querySelector(".switch-name")?.textContent).toBe("添加另一台电脑");
    expect(add?.querySelector(".switch-meta")?.textContent).toBe(
      "先装 pairfob 再执行 pairfob pair。只是多一条凭证，不会替换现在这台。",
    );
    expect((app.querySelector(".computer-add + .lede")) === null).toBe(true);
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
