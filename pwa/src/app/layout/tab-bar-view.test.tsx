import { resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../lib/i18n";
import { MOTION_MS } from "../../shared/ui/dom/motion";
import { appRoot } from "../dom-root";
import { TabBarView } from "./tab-bar-view";

/**
 * The bar stays put while pages change under it, so its own changes are what
 * it shows: a mark that turns up, a count that moves. A bar drawn with its
 * marks, and one drawn again with the same ones, mark nothing.
 */
const badge = () => appRoot().querySelector<HTMLElement>(".tab-bar-badge");
const dot = () => appRoot().querySelector<HTMLElement>(".tab-bar-dot");

function paint(count: number, update = false, mode: "home" | "desktop" | "board" | "settings" = "home", desktopPip?: "ready" | "relay" | "live" | "off", leaving = false): void {
  act(() => renderReact(<TabBarView mode={mode} count={count} update={update} desktopPip={desktopPip} leaving={leaving} />));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});

afterEach(() => { act(() => unmountReact()); });

test("a bar that mounts with its marks, or is drawn again with them, draws them still", () => {
  paint(2, true);
  expect(badge()!.className).toBe("tab-bar-badge");
  expect(badge()!.textContent).toBe("2");
  expect(dot()!.className).toBe("tab-bar-dot");
  paint(2, true);
  paint(2, true, "settings");
  expect(badge()!.className).toBe("tab-bar-badge");
  expect(dot()!.className).toBe("tab-bar-dot");
  expect(appRoot().querySelector(".swap-in")).toBeNull();
});

test("a mark that turns up under the bar pops in; the count that moves fades in on the badge that stays", () => {
  paint(0);
  expect(badge()).toBeNull();
  paint(1, true);
  expect(badge()!.className).toBe("tab-bar-badge pop-in");
  expect(dot()!.className).toBe("tab-bar-dot pop-in");
  // The first number is the badge's own arrival, not a change of it.
  expect(badge()!.querySelector(".swap-in")).toBeNull();

  const kept = badge();
  paint(3, true);
  expectSameNode(badge(), kept);
  expect(badge()!.textContent).toBe("3");
  expect(badge()!.querySelectorAll(".swap-in")).toHaveLength(1);
  // The same count again is a repaint: the number that faded in is not drawn anew.
  const number = badge()!.firstElementChild;
  paint(3, true);
  expectSameNode(badge()!.firstElementChild, number);
});

test("a mark that goes is gone at once, and one that comes back later is a new arrival", async () => {
  paint(2, true);
  paint(0, false);
  expect(badge()).toBeNull();
  expect(dot()).toBeNull();
  expect(appRoot().querySelector(".tab-bar-item .sr-only")).toBeNull();
  await act(() => new Promise<void>((done) => setTimeout(done, MOTION_MS.press + 40)));
  paint(1, false);
  expect(badge()!.className).toBe("tab-bar-badge pop-in");
});

test("renders 3 tabs without view_desktop and 4 tabs (sessions | board | desktop | settings) when enabled", () => {
  paint(0, false, "home");
  expect([...appRoot().querySelectorAll(".tab-bar-label")].map((n) => n.textContent)).toEqual(["会话", "画板", "设置"]);

  paint(0, false, "desktop", "ready");
  const buttons = [...appRoot().querySelectorAll<HTMLButtonElement>(".tab-bar-item")];
  expect(buttons).toHaveLength(4);
  expect(buttons.map((b) => b.querySelector(".tab-bar-label")?.textContent)).toEqual(["会话", "画板", "桌面", "设置"]);
  expect(buttons[2].classList.contains("on")).toBeTrue();
  expect(buttons[2].classList.contains("is-desktop")).toBeTrue();
  expect(buttons[2].getAttribute("aria-current")).toBe("page");
  expect(buttons[2].querySelector(".tab-bar-pip.is-ready")).not.toBeNull();

  paint(0, false, "desktop", "live", true);
  const nav = appRoot().querySelector(".tab-bar")!;
  expect(nav.classList.contains("is-leaving")).toBeTrue();
  expect(nav.getAttribute("aria-hidden")).toBe("true");
  expect(nav.hasAttribute("inert")).toBeTrue();
  expect(buttons[2].querySelector(".tab-bar-pip.is-live")).not.toBeNull();
});
