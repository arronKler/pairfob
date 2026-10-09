import { expectSameNode } from "../../../../test-support/node-identity";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { setLang } from "../../../lib/i18n";
import { applySnapshot } from "../../dashboard/catalog-store";
import { setKeysExpanded, setPadKind } from "../../settings/preferences-store";
import { setComposeDraft, setComposeLive } from "../compose-store";
import { FullTerminalPad } from "../full-terminal/full-terminal-pad";
import { SessionDock } from "../guided/session-dock";
import { selectPane } from "../session-store";
import { emulateTouchDevice } from "../touch-realm";
import { clearModifiers } from "./keypad";
import { PadPages } from "./pad-pages";
import { SHORT_LANDSCAPE_QUERY, shortLandscape } from "./short-landscape";

/**
 * A phone on its side. The finger's dock is dense there: a page is one row of
 * keys, so the terminal keeps its rows and the compose row stays on screen.
 */
const LANDSCAPE = { width: 844, height: 390 };
const PORTRAIT = { width: 390, height: 844 };

const root = () => appRoot();
const pageKeys = () => [...root().querySelectorAll<HTMLElement>(".pad-page .key")].map((el) => el.getAttribute("aria-label"));
const dots = () => [...root().querySelectorAll<HTMLButtonElement>(".pad-page-dot")];
const pageName = () => root().querySelector(".pad-page-name")?.textContent;

let restorePointer: (() => void) | null = null;

/**
 * Resizing the test window tells the query's listeners, as a turned phone does.
 * Happy DOM's listeners start out believing the query does not match, so a
 * test that mounts on a matching window gives it another matching size first.
 */
async function turn(size: { width: number; height: number }): Promise<void> {
  await act(async () => {
    happy.happyDOM.setWindowSize(size);
    await Promise.resolve();
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  restorePointer = emulateTouchDevice();
  applySnapshot({ panes: [{ pane_id: "dense-test", agent: "claude" }] });
  selectPane("dense-test");
  setKeysExpanded(true);
  setPadKind("keys");
  setComposeLive(false);
});

afterEach(() => {
  unmountReact();
  restorePointer?.();
  restorePointer = null;
  clearModifiers();
  setKeysExpanded(false);
  setPadKind("keys");
  setComposeDraft("");
  setComposeLive(false);
  selectPane("");
  happy.happyDOM.setWindowSize(PORTRAIT);
});

describe("the short-landscape query", () => {
  test("a phone on its side matches; the same phone upright does not", () => {
    happy.happyDOM.setWindowSize(LANDSCAPE);
    expect(shortLandscape()).toBeTrue();
    happy.happyDOM.setWindowSize(PORTRAIT);
    expect(shortLandscape()).toBeFalse();
  });

  test("a portrait phone whose keyboard left it wider than tall is not a phone on its side", () => {
    // 360x640 with a 300px keyboard, on a browser that resizes the layout for it.
    happy.happyDOM.setWindowSize({ width: 360, height: 340 });
    expect(shortLandscape()).toBeFalse();
    expect(SHORT_LANDSCAPE_QUERY).toContain("(min-width: 480px)");
  });

  test("a tablet on its side is not short", () => {
    happy.happyDOM.setWindowSize({ width: 1180, height: 820 });
    expect(shortLandscape()).toBeFalse();
  });
});

describe("the guided dock on a phone turned on its side", () => {
  test("is dense: one row of seven keys to a page, four pages, named by their group", () => {
    happy.happyDOM.setWindowSize(LANDSCAPE);
    act(() => { renderReact(createElement(SessionDock, { includeBack: true })); });
    expect(root().querySelector(".dock")?.classList.contains("is-dense")).toBeTrue();
    expect(root().querySelector(".pad-pages")?.classList.contains("is-one-row")).toBeTrue();
    // The survival row is still the first thing in the pad, seven cells.
    expect(root().querySelectorAll(".keys-wrap > .keys > *")).toHaveLength(7);
    expect(pageKeys()).toEqual(["Control", "Alt / Option", "Shift", "Command", "Tab", "Shift+Tab", "Enter"]);
    expect(dots()).toHaveLength(4);
    expect(pageName()).toBe("控制");
    act(() => dots()[1]!.click());
    expect(pageKeys()).toEqual(["Ctrl+C", "Ctrl+D", "Ctrl+Z", "Ctrl+L", "Ctrl+R", "Ctrl+U", "Ctrl+W"]);
    expect(pageName()).toBe("控制");
    act(() => dots()[2]!.click());
    expect(pageKeys()).toEqual(["1", "2", "3", "4", "5", "Y", "N"]);
    expect(pageName()).toBe("选择与编辑");
    act(() => dots()[3]!.click());
    expect(pageKeys()).toHaveLength(7);
    expect(pageKeys()[0]).toBe("空格");
  });

  test("commands keep four columns, one row of them", () => {
    setPadKind("slash");
    happy.happyDOM.setWindowSize(LANDSCAPE);
    act(() => { renderReact(createElement(SessionDock, { includeBack: true })); });
    expect(root().querySelector(".pad-page")?.getAttribute("data-columns")).toBe("4");
    expect(root().querySelectorAll(".pad-page > *")).toHaveLength(4);
  });

  test("turning the phone keeps the keys that were showing, and upright is the two-row pad again", async () => {
    happy.happyDOM.setWindowSize(LANDSCAPE);
    act(() => { renderReact(createElement(SessionDock, { includeBack: true })); });
    const field = root().querySelector("textarea")!;
    await turn({ width: 740, height: 360 });
    act(() => dots()[2]!.click());
    expect(pageKeys()[0]).toBe("1");

    await turn(PORTRAIT);
    expect(root().querySelector(".dock")?.classList.contains("is-dense")).toBeFalse();
    expect(root().querySelector(".pad-pages")?.classList.contains("is-one-row")).toBeFalse();
    expect(dots()).toHaveLength(2);
    expect(pageKeys()).toHaveLength(14);
    expect(pageKeys()[0]).toBe("1");
    expect(dots()[1]!.getAttribute("aria-current")).toBe("page");
    // The compose field is the same node: a turn remounts nothing the reader is typing in.
    expectSameNode(root().querySelector("textarea"), field);

    await turn(LANDSCAPE);
    expect(dots()).toHaveLength(4);
    expect(pageKeys()[0]).toBe("1");
  });

  test("upright it was never dense", () => {
    happy.happyDOM.setWindowSize(PORTRAIT);
    act(() => { renderReact(createElement(SessionDock, { includeBack: true })); });
    expect(root().querySelector(".dock")?.className).toBe("dock");
    expect(root().querySelector(".pad-pages")?.className).toBe("pad-pages");
    expect(pageKeys()).toHaveLength(14);
  });
});

describe("the complete terminal's pad on a phone turned on its side", () => {
  function paint(): void {
    act(() => { renderReact(createElement(FullTerminalPad, { options: {
      sendKey: () => undefined, sendCompose: () => true, hardwareKeyboard: false,
      keyboard: { open() {}, close() {}, toggle() {}, isOpen: () => false },
    } })); });
  }

  test("is dense in 组字: one row to a page under the survival row, the compose form last", () => {
    happy.happyDOM.setWindowSize(LANDSCAPE);
    paint();
    const pad = root().querySelector(".full-terminal-pad")!;
    expect(pad.classList.contains("is-dense")).toBeTrue();
    expect(pageKeys()).toHaveLength(7);
    expect(pad.lastElementChild?.classList.contains("full-terminal-compose-form")).toBeTrue();
  });

  test("in 实时 the keyboard button stands where the compose field was, not in a row of its own", () => {
    setComposeLive(true);
    happy.happyDOM.setWindowSize(LANDSCAPE);
    paint();
    const row = root().querySelector(".full-terminal-live-actions")!;
    expect(row.querySelector(".full-terminal-kb")).not.toBeNull();
    expect(root().querySelector(".full-terminal-pad-controls .full-terminal-kb")).toBeNull();
  });

  test("upright the keyboard button keeps its own row above the keys", () => {
    setComposeLive(true);
    happy.happyDOM.setWindowSize(PORTRAIT);
    paint();
    expect(root().querySelector(".full-terminal-pad")?.className).toBe("full-terminal-pad");
    expect(root().querySelector(".full-terminal-pad-controls > .full-terminal-kb")).not.toBeNull();
    expect(root().querySelector(".full-terminal-live-actions .full-terminal-kb")).toBeNull();
  });
});

describe("a row too narrow for its seven keys", () => {
  /** Give the test DOM the widths a 480px phone lays out: a 460px row, a 90px switch. */
  function narrow(row: number, start: number): () => void {
    const proto = window.HTMLElement.prototype;
    const client = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    const offset = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
    Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("pad-pages") ? row : 0; } });
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("pad-pagination-start") ? start : 0; } });
    return () => {
      if (client) Object.defineProperty(proto, "clientWidth", client); else Reflect.deleteProperty(proto, "clientWidth");
      if (offset) Object.defineProperty(proto, "offsetWidth", offset); else Reflect.deleteProperty(proto, "offsetWidth");
    };
  }

  test("puts fewer keys on a page and the rest on the pages after it; none is left out", () => {
    // A test DOM has no gaps between the row's parts: 430px stands in for the 460px row of a 480px phone.
    const restore = narrow(430, 90);
    try {
      happy.happyDOM.setWindowSize({ width: 480, height: 320 });
      act(() => { renderReact(createElement(SessionDock, { includeBack: true })); });
      const row = root().querySelector<HTMLElement>(".pad-pages")!;
      const columns = Number(row.style.getPropertyValue("--pad-cols"));
      expect(columns).toBeLessThan(7);
      expect(columns).toBeGreaterThanOrEqual(3);
      expect(pageKeys()).toHaveLength(columns);
      // No room for that many dots a finger could tell apart: the page is a count that steps when pressed.
      const pages = Math.ceil(28 / columns);
      expect(dots()).toHaveLength(0);
      const count = () => root().querySelector<HTMLButtonElement>(".pad-page-count")!;
      expect(count().textContent).toBe(`1 / ${pages}`);
      expect(count().getAttribute("aria-label")).toBe(`第 1 页，共 ${pages} 页，点按翻到下一页`);
      // The survival row is untouched: seven cells across the dock's own width.
      expect(root().querySelectorAll(".keys-wrap > .keys > *")).toHaveLength(7);
      // Every key of both groups is on some page, in order, and the page name follows the keys on it.
      const seen: Array<string | null> = [];
      const names: Array<string | undefined> = [];
      for (let page = 0; page < pages; page++) {
        seen.push(...pageKeys());
        names.push(pageName());
        act(() => count().click());
      }
      // Past the last page it comes round to the first.
      expect(count().textContent).toBe(`1 / ${pages}`);
      expect(seen).toHaveLength(28);
      expect(new Set(seen).size).toBe(28);
      expect(seen.slice(0, 7)).toEqual(["Control", "Alt / Option", "Shift", "Command", "Tab", "Shift+Tab", "Enter"]);
      expect(names[0]).toBe("控制");
      expect(names.at(-1)).toBe("选择与编辑");
      // A page is named for the group its first key belongs to.
      expect(names.indexOf("选择与编辑")).toBe(Math.ceil(14 / columns));
    } finally {
      restore();
    }
  });

  test("a row with room keeps its seven, and upright nothing is measured at all", () => {
    const restore = narrow(824, 90);
    try {
      happy.happyDOM.setWindowSize(LANDSCAPE);
      act(() => { renderReact(createElement(SessionDock, { includeBack: true })); });
      const row = root().querySelector<HTMLElement>(".pad-pages")!;
      expect(row.style.getPropertyValue("--pad-cols")).toBe("7");
      expect(root().querySelector(".pad-page-count")).toBeNull();
      expect(dots().length).toBeGreaterThan(1);
      expect(pageKeys()).toHaveLength(7);
    } finally {
      restore();
    }
    unmountReact();
    const narrowAgain = narrow(200, 90);
    try {
      happy.happyDOM.setWindowSize(PORTRAIT);
      act(() => { renderReact(createElement(SessionDock, { includeBack: true })); });
      const row = root().querySelector<HTMLElement>(".pad-pages")!;
      expect(row.style.getPropertyValue("--pad-cols")).toBe("");
      expect(pageKeys()).toHaveLength(14);
    } finally {
      narrowAgain();
    }
  });
});

describe("pages of one row", () => {
  const items = (count: number) => Array.from({ length: count }, (_, n) => createElement("button", { key: n }, String(n)));

  test("a page holds one row of its columns", () => {
    renderReact(createElement(PadPages, { kind: "k", label: "K", columns: 7, rows: 1, items: items(19) }));
    expect(root().querySelectorAll(".pad-page-dot")).toHaveLength(3);
    expect(root().querySelector(".pad-page")!.textContent).toBe("0123456");
    act(() => root().querySelectorAll<HTMLButtonElement>(".pad-page-dot")[2]!.click());
    expect(root().querySelector(".pad-page")!.textContent).toBe("1415161718");
  });
});
