import { resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import type { HerdHostView } from "../model/herd-view";
import { HostTitle } from "./host-title";

/**
 * The rail's status line: the whole sentence when the head has room for it,
 * its parts when it has not. The room and the sentence are measured, so the
 * widths are given here the way a layout would give them.
 */
const app = appRoot;
const host: HerdHostView = { name: "MacBook Pro", line: "已连接 · P2P 直连 · 18 毫秒", tone: "live", brief: ["P2P 直连", "18 毫秒"] };
const realRect = HTMLElement.prototype.getBoundingClientRect;
let room = 0;
let sentence = 0;

const shown = () => [...app().querySelectorAll(".host-title-fact")].map(node => node.textContent);
function paint(view: HerdHostView = host, brief = true): void {
  act(() => renderReact(<HostTitle key={`${view.line}:${room}:${sentence}`} host={view} onOpen={() => {}} brief={brief} />));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const width = this.classList.contains("host-title-whole") ? sentence : this.classList.contains("host-title-line") ? room : 0;
    return { left: 0, top: 0, right: width, bottom: 16, width, height: 16, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});
afterEach(() => {
  act(() => unmountReact());
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

test("the head has room: the rail reads the sentence the phone header reads", () => {
  room = 186;
  sentence = 142;
  paint();
  expect(shown()).toEqual(["已连接 · P2P 直连 · 18 毫秒"]);
  // The sentence is measured from an attribute, so the line's text is only what it shows.
  expect(app().querySelector(".host-title-line")?.textContent).toBe("已连接 · P2P 直连 · 18 毫秒");
  expect(app().querySelector(".host-title-whole")?.getAttribute("data-sentence")).toBe(host.line);
  expect(app().querySelector(".host-title-whole")?.getAttribute("aria-hidden")).toBe("true");
});

test("a sentence wider than the head falls back to its parts, each whole, most telling first", () => {
  room = 164;
  sentence = 168;
  paint({ ...host, line: "Connected · P2P direct · 18 ms", brief: ["P2P direct", "18 ms"] });
  expect(shown()).toEqual(["P2P direct", " · 18 ms"]);
  // To the pixel: a sentence exactly as wide as the line is shown.
  sentence = 164;
  paint({ ...host, line: "Connected · P2P direct · 18 ms", brief: ["P2P direct", "18 ms"] });
  expect(shown()).toEqual(["Connected · P2P direct · 18 ms"]);
});

test("a line that is not laid out judges nothing and keeps the parts", () => {
  room = 0;
  sentence = 0;
  paint();
  expect(shown()).toEqual(["P2P 直连", " · 18 毫秒"]);
});

test("the button's name and tooltip carry the whole status whatever the line shows", () => {
  room = 100;
  sentence = 142;
  paint();
  const button = app().querySelector<HTMLButtonElement>(".host-title")!;
  expect(button.getAttribute("aria-label")).toContain(host.line);
  expect(button.title).toBe(`MacBook Pro · ${host.line}`);
});

test("the phone header is the plain sentence, with nothing measured", () => {
  room = 100;
  sentence = 142;
  paint(host, false);
  const line = app().querySelector(".host-title-line")!;
  expect(line.className).toBe("host-title-line");
  expect(line.children).toHaveLength(0);
  expect(line.textContent).toBe(host.line);
});
