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

  test("a short snapshot does not cap a taller visible terminal on open", () => {
    const view = setup(24);
    expect(view.fit().rows).toBe(40);
    expect(view.terminal.rows).toBe(24);
  });
});