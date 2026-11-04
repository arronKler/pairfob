import { act } from "react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { appRoot } from "../../app/dom-root";
import { setLang, t } from "../../lib/i18n";
import { ComputerListView } from "./computer-list-view";
import type { ComputersViewModel } from "./model";

/**
 * The end of a computer's row inside the app: Connect, the spinner of a
 * connection being made and the "current" tag take turns in one slot, each
 * swapped in, and the slot is as wide as Connect whichever stands in it.
 */
const row = (daemonId: string, title: string, current: boolean, held = false) => ({
  daemonId, title, current, held, currentPill: current ? "当前" : null, meta: current ? "已连接" : held ? "已连接 · 即时切换" : "上次连接：昨天",
  forgetAria: `忘记 ${title}`, forgetLabel: "忘记", renameAria: `改电脑名 ${title}`, renameLabel: "改电脑名",
});
const model = (current: string, held: string[] = []): ComputersViewModel => ({
  withBack: true, backTitle: "电脑", backTarget: "settings", heading: null,
  rows: [row("a", "MacBook Pro", current === "a", held.includes("a")), row("b", "Mac mini", current === "b", held.includes("b"))],
  addLabel: "添加电脑", addHint: "", showManualUpdateHelp: false, pageClass: "",
});

let connect: (() => void) | null = null;
const switched: string[] = [];
const renamed: string[] = [];
const forgotten: string[] = [];
function paint(current: string, held: string[] = []): void {
  renderReact(<ComputerListView view={model(current, held)} onForget={(daemonId) => { forgotten.push(daemonId); }}
    onRename={(daemonId) => { renamed.push(daemonId); }} onAdd={() => {}} onBack={() => {}}
    onSwitch={(daemonId) => { switched.push(daemonId); return new Promise<void>((resolve) => { connect = resolve; }); }} />);
}
function paintStandalone(): void {
  renderReact(<ComputerListView view={{ ...model("a"), withBack: false, heading: { title: "连不上电脑", lede: "" } }}
    onForget={(daemonId) => { forgotten.push(daemonId); }} onRename={(daemonId) => { renamed.push(daemonId); }}
    onAdd={() => {}} onBack={() => {}} onSwitch={() => {}} />);
}
const items = () => [...appRoot().querySelectorAll<HTMLElement>(".computer-item")];
const face = (item: HTMLElement) => item.querySelector<HTMLElement>(".computer-trail-face")!;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  connect = null;
  switched.length = 0;
  renamed.length = 0;
  forgotten.length = 0;
});
afterEach(() => act(unmountReact));

test("a row's end is one slot: as wide as Connect, and still on a first paint", () => {
  paint("a");
  for (const item of items()) {
    // What keeps the slot's width is not there for a press or for assistive technology.
    const sizer = item.querySelector<HTMLElement>(".computer-trail-size")!;
    expect([sizer.tagName, sizer.getAttribute("aria-hidden"), sizer.textContent]).toEqual(["SPAN", "true", t("set.connect")]);
    expect(face(item).classList.contains("swap-in")).toBe(false);
  }
  expect(face(items()[0]).textContent).toBe("当前");
  expect(appRoot().querySelectorAll("button.set-action")).toHaveLength(1);
});

test("connecting swaps the spinner in where Connect stood, then the tag where the connection landed", async () => {
  paint("a");
  const [first, second] = items();
  act(() => second.querySelector<HTMLButtonElement>("button.set-action")!.click());
  expect(switched).toEqual(["b"]);
  expect(face(second).classList.contains("swap-in")).toBe(true);
  expect(face(second).querySelector(".spinner")).not.toBeNull();
  expect(second.querySelector(".set-item-sub")?.textContent).toBe(t("set.connecting"));
  expect(second.querySelector(".set-item-sub .swap-in")).not.toBeNull();
  // The row that did not change says nothing.
  expect(face(first).classList.contains("swap-in")).toBe(false);
  // The connection lands: the other computer is the current one.
  await act(async () => { connect?.(); await Promise.resolve(); });
  paint("b");
  expectSameNode(items()[1], second);
  expect(face(second).textContent).toBe("当前");
  expect(face(second).classList.contains("swap-in")).toBe(true);
  expect(face(first).querySelector("button.set-action")?.textContent).toBe(t("set.connect"));
  expect(face(first).classList.contains("swap-in")).toBe(true);
});

test("a held row offers Switch where a cold one offers Connect, and says so", () => {
  paint("a", ["b"]);
  const held = items()[1];
  expect(held.querySelector(".set-item-sub")?.textContent).toBe("已连接 · 即时切换");
  expect(held.querySelector("button.set-action")?.textContent).toBe("切换");

  paint("a");
  const cold = items()[1];
  expect(cold.querySelector("button.set-action")?.textContent).toBe(t("set.connect"));
  expect(cold.querySelector(".set-item-sub")?.textContent).toBe("上次连接：昨天");
});

test("under Edit the slot holds Rename and Forget, and nothing keeps it wide", () => {
  paint("a");
  act(() => appRoot().querySelector<HTMLButtonElement>(".computers-edit")!.click());
  for (const item of items()) {
    expect(item.querySelector(".computer-trail-size")).toBeNull();
    expect(face(item).querySelector(".computer-forget-action")?.textContent).toBe("忘记");
  }
});

test("under Edit every row offers Rename before Forget, and each action owns its tap", () => {
  paint("a");
  act(() => appRoot().querySelector<HTMLButtonElement>(".computers-edit")!.click());
  for (const item of items()) {
    const actions = [...face(item).querySelectorAll<HTMLButtonElement>("button.set-action")];
    expect(actions.map(action => action.textContent)).toEqual(["改电脑名", "忘记"]);
  }
  const [first, second] = items();
  act(() => face(second).querySelectorAll<HTMLButtonElement>("button.set-action")[0].click());
  expect(renamed).toEqual(["b"]);
  expect(forgotten).toEqual([]);
  act(() => face(first).querySelectorAll<HTMLButtonElement>("button.set-action")[1].click());
  expect(forgotten).toEqual(["a"]);
});

test("the offline picker offers Rename beside Forget on every saved computer", () => {
  paintStandalone();
  const rows = [...appRoot().querySelectorAll<HTMLElement>(".computer-row")];
  expect(rows).toHaveLength(2);
  for (const item of rows) {
    expect(item.querySelector<HTMLButtonElement>(".computer-rename")?.textContent).toBe("改电脑名");
    expect(item.querySelector<HTMLButtonElement>(".computer-forget")?.textContent).toBe("忘记");
  }
  act(() => rows[1].querySelector<HTMLButtonElement>(".computer-rename")!.click());
  expect(renamed).toEqual(["b"]);
  expect(forgotten).toEqual([]);
});
