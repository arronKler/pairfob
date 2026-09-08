import { resetTestDOM } from "../../test-support/boot-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { app, state, clearNotice } from "../state";
import { setLang, t } from "../lib/i18n";
import { setRenderer } from "../paint";
import { renderComputers } from "./computers";
import { leaveReactScreen } from "./react/root";

function computer(daemonId: string, hostname: string): (typeof state.computers)[number] {
  return { daemonId, hostname, deviceId: "dev_abcdefgh", psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
    fp: "0".repeat(16), relayOrigin: "https://pairfob.com", label: "phone", createdAt: 1700000000000 };
}
beforeEach(async () => {
  await resetTestDOM();
  act(() => { leaveReactScreen(); clearNotice(); });
  setLang("zh");
  Object.assign(state, { phase: "pick", screen: "computers", live: null, credential: null,
    addingComputer: false, computers: [computer("daemon-a", "desk")] });
  setRenderer(renderComputers);
});
afterEach(() => {
  act(() => { leaveReactScreen(); clearNotice(); });
  setRenderer(() => {});
  state.phase = "boot";
  state.computers = [];
});
const paint = () => act(renderComputers);

describe("computer picker copy", () => {
  test("one stored computer is an offline retry, not a multi-machine chooser", () => {
    paint();
    expect(app.querySelector(".prelude-title")?.textContent).toBe(t("computers.offlineTitle"));
    expect(app.querySelector(".lede")?.textContent).toBe(t("computers.offlineLede"));
    state.computers.push(computer("daemon-b", "studio"));
    paint();
    expect(app.querySelector(".prelude-title")?.textContent).toBe(t("computers.pick"));
    expect(app.querySelector(".lede")?.textContent).toBe(t("computers.multiLede"));
  });

  test("adding another computer is a list row, not a ghost caption", () => {
    paint();
    const add = app.querySelector("button.switch-item.computer-add")!;
    expect(add).toBeTruthy();
    expect(add.querySelector(".add-mark")).toBeTruthy();
    expect(add.querySelector(".switch-name")?.textContent).toBe(t("settings.addComputer"));
    expect(add.querySelector(".switch-meta")?.textContent).toBe(t("computers.addHint"));
    expect(add.classList.contains("btn-ghost")).toBeFalse();
    expect([...app.querySelectorAll("p.lede")].some(p => p.textContent === t("computers.addHint"))).toBeFalse();
  });

  test("forgetting a computer is local and does not say revoke", () => {
    paint();
    const forget = app.querySelector(".computer-forget")!;
    expect(forget).toBeTruthy();
    expect(forget.getAttribute("aria-label")).toBe(t("computers.forgetAria", { title: "desk" }));
    expect(forget.textContent).not.toContain("吊销这台设备");
  });
});
