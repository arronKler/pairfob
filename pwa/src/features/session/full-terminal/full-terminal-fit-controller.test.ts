import { Window } from "happy-dom";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "localStorage", "navigator", "location"] as const) {
  globals[key] = happy[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

import { appRoot } from "../../../app/dom-root";
import { selectPane } from "../session-store";
import { setTermFontPx, setTermGrid } from "../../settings/preferences-store";
import * as catalog from "../../dashboard/catalog-store";
import * as board from "../../board/layout-store";
import { fitFullTerminal } from "./full-terminal-fit-controller.ts";
import { bindPanBar } from "./full-terminal-pan-bar.ts";
import type { DashboardAgentCard } from "../../../lib/dashboard";
import type { TabLayoutView } from "../../../lib/layout";

/**
 * One pane on a fixed 106x60 board cell with a reported scroll viewport.
 *
 * This is a unit geometry test: the fit function's inputs (the projected card
 * and the board layout) are supplied as scoped spies on the exact readers
 * `full-terminal-fit-controller.ts` imports (`liveAgents` / `boardLayouts`),
 * so the catalog and board domains are never mutated, no foreign pane
 * preference is pruned and refreshBusy is never touched. The real
 * fitFullTerminal geometry stays unmocked. Both spies are restored in
 * afterEach (concrete reader refs), never persisted globals.
 */
const PROJECTED_CARD = (rows: number): DashboardAgentCard[] =>
  [{ paneId: "p1", viewportRows: rows }] as unknown as DashboardAgentCard[];

const BOARD_LAYOUT: TabLayoutView[] = [{
  workspaceId: "w1",
  tabId: "t1",
  zoomed: false,
  focusedPaneId: "p1",
  area: { x: 0, y: 0, width: 106, height: 60 },
  panes: [{ paneId: "p1", focused: true, rect: { x: 0, y: 0, width: 106, height: 60 } }],
}];

let liveAgentsSpy: ReturnType<typeof spyOn> | null = null;
let boardLayoutsSpy: ReturnType<typeof spyOn> | null = null;

function setup(snapshotRows = 40) {
  selectPane("p1");
  setTermGrid("pan", 80);
  setTermFontPx(12);
  let viewportRows = snapshotRows;
  liveAgentsSpy = spyOn(catalog, "liveAgents").mockImplementation(
    () => PROJECTED_CARD(viewportRows),
  );
  boardLayoutsSpy = spyOn(board, "boardLayouts").mockImplementation(() => BOARD_LAYOUT);
  const root = document.createElement("div");
  const host = document.createElement("div");
  host.className = "full-terminal-host";
  host.style.padding = "4px";
  host.innerHTML = '<div class="full-terminal-pan"><div class="full-terminal-canvas"></div></div>';
  root.append(host);
  appRoot().append(root);
  let height = 648;
  Object.defineProperties(host, {
    clientWidth: { value: 390 },
    clientHeight: { get: () => height },
  });
  const terminal = {
    cols: 106, rows: snapshotRows,
    options: { fontSize: 12, lineHeight: 1.5, letterSpacing: 0 },
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; },
  };
  let remoteGrid = { cols: 106, rows: snapshotRows };
  return {
    terminal,
    fit(nextHeight = height) {
      height = nextHeight;
      return fitFullTerminal({
        root, host, terminal, fitAddon: { fit() {} }, lockedFont: null, remoteGrid,
      } as unknown as Parameters<typeof fitFullTerminal>[0])!.size;
    },
    receiveFrame(rows: number) {
      remoteGrid = { cols: 106, rows };
      viewportRows = rows;
    },
  };
}

// Restored after each test so later suites see the real catalog/board readers.
afterEach(() => {
  appRoot().replaceChildren();
  appRoot().className = "";
  appRoot().style.removeProperty("--rail-w");
  liveAgentsSpy?.mockRestore();
  boardLayoutsSpy?.mockRestore();
});

describe("complete-terminal height recovery", () => {
  test("collapsing the keypad restores requested rows after a smaller snapshot arrives", () => {
    const view = setup();
    expect(view.fit().rows).toBe(40);
    expect(view.fit(488).rows).toBe(30);
    view.receiveFrame(30);
    expect(view.fit().rows).toBe(30);
    expect(view.terminal.rows).toBe(30);

    const restored = view.fit(648);
    expect(restored.rows).toBe(40);
    expect(restored.cols).toBe(106);
    // Keep the old frame grid until the daemon sends the larger full frame.
    expect(view.terminal.rows).toBe(30);
    view.receiveFrame(restored.rows);
    view.fit();
    expect(view.terminal.rows).toBe(40);
  });

  test("a row shorter than the protocol's five rows keeps all five and shows the ones the cursor is in", () => {
    // A small phone on its side with its pad open leaves the terminal about
    // three rows. The grid cannot have fewer than five, so the canvas keeps
    // five and slides, as it does under a pad, instead of losing the prompt.
    const view = setup(5);
    const terminal = view.terminal as typeof view.terminal & { buffer: { active: { cursorY: number } } };
    terminal.buffer = { active: { cursorY: 4 } };
    const canvas = appRoot().querySelector<HTMLElement>(".full-terminal-canvas")!;
    // 64px of host is 56px inside its padding: three and a half 16px rows.
    expect(view.fit(64).rows).toBe(5);
    expect(view.terminal.rows).toBe(5);
    expect(canvas.style.height).toBe("80px");
    // The cursor is on the last row: the canvas slides up by the 24px that do not fit.
    expect(canvas.style.marginTop).toBe("-24px");

    // A prompt on the first row stays put, and one in between slides just far enough.
    terminal.buffer.active.cursorY = 0;
    view.fit(64);
    expect(canvas.style.marginTop).toBe("");
    terminal.buffer.active.cursorY = 3;
    view.fit(64);
    expect(canvas.style.marginTop).toBe("-8px");

    // With room for all five the canvas is the row's own height again.
    view.fit(648);
    expect(canvas.style.height).toBe("");
    expect(canvas.style.marginTop).toBe("");
  });

  test("a short snapshot does not cap a taller visible terminal on open", () => {
    const view = setup(24);
    expect(view.fit().rows).toBe(40);
    expect(view.terminal.rows).toBe(24);
  });
});
/**
 * A host whose width the test moves, with an 8px cell and no board pane, so the
 * requested columns are a function of the host width, the window width and the
 * width mode alone. `fit()` threads the hold the way the controller does.
 *
 * `inspector()` puts the desk shell's third column beside it, as wide as the
 * test says, `hideList()` is the shell giving the list's column away,
 * `keys()` is the pad a mouse calls up under the terminal, and `cursor()` is
 * the row the computer's last frame left the cursor on.
 */
function column(mode: "fit" | "pan", cols: 80 | 100 | 120 = 80) {
  selectPane("p1");
  setTermGrid(mode, cols);
  setTermFontPx(12);
  liveAgentsSpy = spyOn(catalog, "liveAgents").mockImplementation(() => []);
  boardLayoutsSpy = spyOn(board, "boardLayouts").mockImplementation(() => []);
  const root = document.createElement("div");
  const host = document.createElement("div");
  host.className = "full-terminal-host";
  host.innerHTML = '<div class="full-terminal-pan"><div class="full-terminal-canvas"></div></div>';
  root.append(host);
  appRoot().append(root);
  let width = 1138;
  let height = 648;
  Object.defineProperties(host, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  });
  const pad = document.createElement("div");
  pad.className = "full-terminal-pad";
  root.append(pad);
  let cell: { width: number; height: number } | undefined = { width: 8, height: 16 };
  const terminal = {
    cols: 80, rows: 24,
    options: { fontSize: 12, lineHeight: 1.5, letterSpacing: 0 },
    buffer: { active: { cursorY: 0 } },
    _core: { _renderService: { get dimensions() { return { css: { cell } }; } } },
    resize(nextCols: number, nextRows: number) { this.cols = nextCols; this.rows = nextRows; },
  };
  let hold: NonNullable<ReturnType<typeof fitFullTerminal>>["hold"] = null;
  let aside: HTMLElement | null = null;
  const canvas = host.querySelector<HTMLElement>(".full-terminal-canvas")!;
  /** The canvas box xterm's own fit ran against, one entry per run. */
  const probes: string[] = [];
  return {
    host,
    terminal,
    canvas,
    probes,
    cursor(row: number) { terminal.buffer.active.cursorY = row; },
    loseCell() { cell = undefined; },
    findCell() { cell = { width: 8, height: 16 }; },
    inspector(inspectorWidth: number | null) {
      aside?.remove();
      aside = null;
      appRoot().classList.toggle("desk", true);
      appRoot().classList.toggle("inspector", inspectorWidth !== null);
      appRoot().classList.remove("rail-hidden");
      if (inspectorWidth === null) return;
      aside = document.createElement("aside");
      aside.className = "inspector";
      aside.style.width = `${inspectorWidth}px`;
      appRoot().append(aside);
    },
    hideList(listWidth: number) {
      appRoot().classList.add("rail-hidden");
      appRoot().style.setProperty("--rail-w", `${listWidth}px`);
    },
    /** The momentary pad opens (and takes its height from the host) or closes. */
    keys(keysHeight: number | null) {
      pad.replaceChildren();
      const padHeight = 80 + (keysHeight ?? 0);
      height = 648 - (keysHeight ?? 0);
      Object.defineProperties(pad, {
        offsetHeight: { value: padHeight + 1, configurable: true },
        clientHeight: { value: padHeight, configurable: true },
        scrollHeight: { value: padHeight, configurable: true },
      });
      if (keysHeight === null) return;
      const controls = document.createElement("div");
      controls.className = "full-terminal-pad-controls is-momentary";
      Object.defineProperty(controls, "offsetHeight", { value: keysHeight });
      pad.append(controls);
    },
    /** The draft is `lines` long: every line past the first takes 20px from the host. */
    draft(lines: number) {
      pad.replaceChildren();
      const grown = (lines - 1) * 20;
      height = 648 - grown;
      Object.defineProperties(pad, {
        offsetHeight: { value: 81 + grown, configurable: true },
        clientHeight: { value: 80 + grown, configurable: true },
        scrollHeight: { value: 80 + grown, configurable: true },
      });
      const field = document.createElement("textarea");
      field.className = "full-terminal-compose-input";
      Object.defineProperty(field, "offsetHeight", { value: 46 + grown });
      pad.append(field);
    },
    fit(nextWidth = width, lockedFont: number | null = null) {
      width = nextWidth;
      const result = fitFullTerminal({
        root, host, terminal, fitAddon: { fit() { probes.push(canvas.style.width); } }, lockedFont, remoteGrid: null, hold,
      } as unknown as Parameters<typeof fitFullTerminal>[0])!;
      hold = result.hold;
      return result.size;
    },
  };
}

describe("only the window resizing moves the computer's terminal", () => {
  const WINDOW = 1440;
  afterEach(() => { happy.happyDOM.setWindowSize({ width: 390, height: 844 }); });

  test("fit keeps its columns when the same window narrows the host, and pans them", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    expect(view.fit(1138).cols).toBe(142);
    expect(view.host.classList.contains("is-pan")).toBeFalse();
    // A grid the host shows fills it through the style sheet: no pixel width to overflow by.
    expect(view.canvas.style.width).toBe("");

    // The same window, a narrower host.
    const narrowed = view.fit(618);
    expect(narrowed.cols).toBe(142);
    expect(view.terminal.cols).toBe(142);
    expect(view.host.classList.contains("is-pan")).toBeTrue();
    expect(view.canvas.style.width).toBe(`${142 * 8}px`);

    // It widens again: nothing to pan, nothing asked of the computer.
    expect(view.fit(1138).cols).toBe(142);
    expect(view.host.classList.contains("is-pan")).toBeFalse();
    expect(view.canvas.style.width).toBe("");
  });

  test("a wider host at the same window width does not grow the columns either", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    expect(view.fit(618).cols).toBe(77);
    expect(view.fit(1138).cols).toBe(77);
    expect(view.host.classList.contains("is-pan")).toBeFalse();
  });

  test("a window resize measures the columns afresh", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    expect(view.fit(1138).cols).toBe(142);
    expect(view.fit(618).cols).toBe(142);
    happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
    expect(view.fit(618).cols).toBe(77);
    expect(view.host.classList.contains("is-pan")).toBeFalse();
  });

  test("fixed columns that widened to fill the column are held the same way", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("pan", 80);
    // Wider than its 80 columns, the fixed mode asks for what the host shows.
    expect(view.fit(1138).cols).toBe(142);
    expect(view.fit(618).cols).toBe(142);
    expect(view.host.classList.contains("is-pan")).toBeTrue();
    expect(view.canvas.style.width).toBe(`${142 * 8}px`);
  });

  test("fixed columns the host never fitted are an ordinary pan", () => {
    const view = column("pan", 80);
    // A phone: 80 columns in a 390px host is the mode itself.
    expect(view.fit(390).cols).toBe(80);
    expect(view.fit(390).cols).toBe(80);
    expect(view.host.classList.contains("is-pan")).toBeTrue();
    expect(view.canvas.style.width).toBe(`${80 * 8}px`);
  });

  test("a new width mode, column target or type size is the reader asking, and refits", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    expect(view.fit(1138).cols).toBe(142);
    expect(view.fit(618).cols).toBe(142);

    setTermGrid("pan", 100);
    expect(view.fit(618).cols).toBe(100);
    setTermGrid("pan", 120);
    expect(view.fit(618).cols).toBe(120);
    setTermGrid("fit", 120);
    expect(view.fit(618).cols).toBe(77);

    // A pinch locks another type size: the columns follow it.
    expect(view.fit(1138).cols).toBe(77);
    expect(view.fit(1138, 14).cols).toBe(142);
  });

  test("a fit that could not measure a cell is never held", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    view.loseCell();
    // No renderer metrics yet: the columns are the terminal's own guess.
    expect(view.fit(1138).cols).toBe(80);
    view.findCell();
    expect(view.fit(1138).cols).toBe(142);
  });
});

describe("the inspector covers part of the terminal's column without resizing the computer's terminal", () => {
  const WINDOW = 1440;
  afterEach(() => { happy.happyDOM.setWindowSize({ width: 390, height: 844 }); });

  test("a terminal opened with the inspector already beside it is sized for the column without it", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    view.inspector(520);
    expect(view.fit(618).cols).toBe(142);
    expect(view.host.classList.contains("is-pan")).toBeTrue();
    expect(view.canvas.style.width).toBe(`${142 * 8}px`);

    view.inspector(null);
    expect(view.fit(1138).cols).toBe(142);
    expect(view.host.classList.contains("is-pan")).toBeFalse();
  });

  test("a window resize with the inspector open fits to the column without it, and closing it changes nothing", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    expect(view.fit(1138).cols).toBe(142);
    view.inspector(520);
    expect(view.fit(618).cols).toBe(142);

    // 1440 → 1280: the session column is 978px without its 461px inspector.
    happy.happyDOM.setWindowSize({ width: 1280, height: 900 });
    view.inspector(461);
    expect(view.fit(517).cols).toBe(122);
    expect(view.host.classList.contains("is-pan")).toBeTrue();

    view.inspector(null);
    expect(view.fit(978).cols).toBe(122);
    expect(view.host.classList.contains("is-pan")).toBeFalse();
    expect(view.canvas.style.width).toBe("");
  });

  test("the list's column comes back with the inspector gone, so it is not the terminal's to count", () => {
    happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
    const view = column("fit");
    // 1024 wide: the inspector takes 502px and the 280px list gives way.
    view.inspector(502);
    view.hideList(280);
    expect(view.fit(506).cols).toBe(Math.floor((506 + 502 - 280) / 8));

    view.inspector(null);
    expect(view.fit(728).cols).toBe(91);
  });

  test("fixed columns keep their own count and still pan", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("pan", 120);
    view.inspector(520);
    // 318 + 520 shows 104 columns: fewer than the mode's 120, which stay.
    expect(view.fit(318).cols).toBe(120);
    expect(view.host.classList.contains("is-pan")).toBeTrue();
    view.inspector(null);
    expect(view.fit(838).cols).toBe(120);
    expect(view.host.classList.contains("is-pan")).toBeTrue();
  });
});

describe("the rows do not depend on what happens to be over the terminal", () => {
  const WINDOW = 1440;
  afterEach(() => { happy.happyDOM.setWindowSize({ width: 390, height: 844 }); });

  test("the pad a mouse calls up keeps the rows, and a cursor on the last one slides the canvas up by what the pad covers", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    view.keys(null);
    expect(view.fit().rows).toBe(40);
    view.cursor(39);
    expect(view.fit().rows).toBe(40);
    expect(view.canvas.style.marginTop).toBe("");

    view.keys(178);
    expect(view.fit().rows).toBe(40);
    expect(view.terminal.rows).toBe(40);
    // xterm still fits against the whole room, so it never drops a row on the way.
    expect(view.canvas.style.height).toBe("648px");
    expect(view.canvas.style.marginTop).toBe("-178px");

    view.keys(null);
    expect(view.fit().rows).toBe(40);
    expect(view.canvas.style.height).toBe("");
    expect(view.canvas.style.marginTop).toBe("");
  });

  test("a prompt on the first row stays where it is under the pad", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    view.keys(null);
    view.fit();
    view.cursor(0);

    view.keys(178);
    expect(view.fit().rows).toBe(40);
    expect(view.terminal.rows).toBe(40);
    // Still the whole grid, clipped at the bottom instead of the top.
    expect(view.canvas.style.height).toBe("648px");
    expect(view.canvas.style.marginTop).toBe("");

    // 470px show 29 whole rows: the cursor can be on any of them without a slide.
    view.cursor(28);
    view.fit();
    expect(view.canvas.style.marginTop).toBe("");
  });

  test("a cursor between the two slides just far enough to clear the pad", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    view.keys(178);
    // Row 32 ends 528px down a canvas the pad leaves 470px of.
    view.cursor(32);
    expect(view.fit().rows).toBe(40);
    expect(view.canvas.style.marginTop).toBe("-58px");

    // The cursor went back up: so does the canvas.
    view.cursor(3);
    view.fit();
    expect(view.canvas.style.marginTop).toBe("");
  });

  test("a draft of several lines keeps the rows on the phone too, and gives them back with nothing asked when it is sent", () => {
    const view = column("pan", 80);
    view.draft(1);
    expect(view.fit(390).rows).toBe(40);
    expect(view.canvas.style.height).toBe("");
    view.cursor(39);

    // Five lines cover 80px of the terminal: the grid stays and slides up for the cursor.
    view.draft(5);
    expect(view.fit(390).rows).toBe(40);
    expect(view.terminal.rows).toBe(40);
    expect(view.canvas.style.height).toBe("648px");
    expect(view.canvas.style.marginTop).toBe("-80px");

    // A prompt further up stays where it is; the draft covers the rows under it.
    view.cursor(10);
    view.fit(390);
    expect(view.canvas.style.marginTop).toBe("");

    view.draft(1);
    expect(view.fit(390).rows).toBe(40);
    expect(view.canvas.style.height).toBe("");
    expect(view.canvas.style.marginTop).toBe("");
  });

  test("every fit tells the bar under the terminal what overflows now", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    const pan = view.host.querySelector<HTMLElement>(".full-terminal-pan")!;
    const bar = document.createElement("div");
    bar.innerHTML = "<span></span>";
    view.host.append(bar);
    // What the pan row holds is the grid xterm drew last, as wide as the terminal's columns.
    Object.defineProperties(pan, {
      scrollWidth: { get: () => Math.max(view.host.clientWidth, view.terminal.cols * 8) },
      clientWidth: { get: () => view.host.clientWidth },
      clientHeight: { value: 648 },
    });
    view.fit(1138);
    const stop = bindPanBar(bar, pan);
    expect(bar.hidden).toBeTrue();

    // The inspector opens over the same window: the held columns pan, and the bar says so.
    view.fit(618);
    expect(bar.hidden).toBeFalse();
    // The window itself narrows: the grid is refitted to the column and nothing pans.
    happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
    view.fit(618);
    expect(view.terminal.cols).toBe(77);
    expect(bar.hidden).toBeTrue();
    stop();
  });

  test("xterm's own fit never runs against a box narrower than the grid it already drew", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("pan", 120);
    // 120 fixed columns in a 618px column: 960px of grid, panned.
    expect(view.fit(618).cols).toBe(120);
    view.probes.length = 0;
    // A refit that asks nothing of the computer (the inspector, the pad) gets no
    // repaint, so a 618px box here would cost columns 78 to 120 their text.
    view.fit(618);
    expect(view.probes).toEqual(["960px", "960px"]);
  });

  test("a column half a pixel short of a whole one neither overflows nor rounds up to another column", () => {
    happy.happyDOM.setWindowSize({ width: WINDOW, height: 900 });
    const view = column("fit");
    const pan = view.host.querySelector<HTMLElement>(".full-terminal-pan")!;
    // Layout gave the pan 1127.6px; `clientWidth` reports that as 1128, which is 141 whole cells.
    pan.style.width = "1127.6px";
    Object.defineProperties(pan, { clientWidth: { value: 1128 }, clientHeight: { value: 648 } });
    expect(view.fit(1128).cols).toBe(140);
    expect(view.host.classList.contains("is-pan")).toBeFalse();
    expect(view.canvas.style.width).toBe("");
  });
});
