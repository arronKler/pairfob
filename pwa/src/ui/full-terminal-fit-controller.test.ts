import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "HTMLElement", "localStorage", "navigator", "location"] as const) {
  globals[key] = happy[key];
}
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, state } = await import("../state.ts");
const { fitFullTerminal } = await import("./full-terminal-fit-controller.ts");

afterEach(() => {
  app.replaceChildren();
  state.agents = [];
  state.layouts = [];
});

function setup(snapshotRows = 40) {
  state.paneId = "p1";
  state.termFit = "pan";
  state.termFontPx = 12;
  state.termCols = 80;
  state.agents = [{ paneId: "p1", viewportRows: snapshotRows }];
  state.layouts = [{
    workspaceId: "w1", tabId: "t1", zoomed: false, focusedPaneId: "p1",
    area: { x: 0, y: 0, width: 106, height: 60 },
    panes: [{ paneId: "p1", focused: true, rect: { x: 0, y: 0, width: 106, height: 60 } }],
  }];
  const root = document.createElement("div");
  const host = document.createElement("div");
  host.className = "full-terminal-host";
  host.style.padding = "4px";
  host.innerHTML = '<div class="full-terminal-pan"><div class="full-terminal-canvas"></div></div>';
  root.append(host);
  app.append(root);
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
      state.agents[0].viewportRows = rows;
    },
  };
}

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
