import { describe, expect, test } from "bun:test";
import {
  AGENT_TRACE_IDLE_MS,
  PANE_READ_FALLBACK_MS,
  PANE_STATUS_FLOOR_MS,
  SNAPSHOT_FALLBACK_MS,
  panePollDelayMs,
  pokeRefreshAction,
  shouldPullStatus,
} from "./poll.ts";

const stateSrc = await Bun.file(new URL("./state.ts", import.meta.url)).text();
const noticesSrc = await Bun.file(new URL("./lib/notices.ts", import.meta.url)).text();
const liveSrc = await Bun.file(new URL("./live.ts", import.meta.url)).text();
const pollingSrc = await Bun.file(new URL("./live-polling.ts", import.meta.url)).text();

describe("refresh contract constants", () => {
  test("keeps the visible pane at the established 1.5s refresh cadence", () => {
    expect(SNAPSHOT_FALLBACK_MS).toBe(15_000);
    expect(PANE_READ_FALLBACK_MS).toBe(1_500);
    expect(stateSrc).toContain("export { SNAPSHOT_FALLBACK_MS, PANE_READ_FALLBACK_MS }");
    expect(noticesSrc).toContain('"locator_required"');
    expect(noticesSrc).toContain('"rate_limited"');
    expect(pollingSrc).toContain("SNAPSHOT_FALLBACK_MS");
    expect(pollingSrc).toContain("callbacks.canReadPane() ? callbacks.paneDelayMs() : PANE_TIMER_IDLE_MS");
    expect(liveSrc).not.toContain("setInterval(");
    expect(pollingSrc).not.toContain("stablePaneReads");
  });

  test("the board screen polls pane.read into cell previews", () => {
    const canRead = liveSrc.slice(liveSrc.indexOf("canReadPane:"), liveSrc.indexOf("paneDelayMs:"));
    expect(canRead).toContain('state.screen === "board"');
    expect(liveSrc).toContain("refreshBoardPreviews");
  });
});

describe("pane polling policy", () => {
  test("keeps active agents realtime and backs off completed conversations", () => {
    expect(panePollDelayMs(true, true)).toBe(PANE_READ_FALLBACK_MS);
    expect(panePollDelayMs(true, false)).toBe(AGENT_TRACE_IDLE_MS);
    expect(panePollDelayMs(false, false)).toBe(PANE_READ_FALLBACK_MS);
    expect(AGENT_TRACE_IDLE_MS).toBeLessThan(SNAPSHOT_FALLBACK_MS);
  });
});

describe("pane changes pull agent status forward", () => {
  test("an unchanged buffer never costs a Snapshot", () => {
    expect(shouldPullStatus(false, 100_000, 0)).toBe(false);
  });

  test("a changed buffer refreshes status well inside the Snapshot fallback", () => {
    expect(shouldPullStatus(true, PANE_STATUS_FLOOR_MS, 0)).toBe(true);
    expect(PANE_STATUS_FLOOR_MS).toBeLessThan(SNAPSHOT_FALLBACK_MS);
  });

  test("a streaming agent cannot turn every read into a Snapshot", () => {
    expect(shouldPullStatus(true, PANE_READ_FALLBACK_MS, 0)).toBe(false);
    expect(PANE_STATUS_FLOOR_MS).toBeGreaterThan(PANE_READ_FALLBACK_MS);
  });

  test("the pane read path is what triggers it", () => {
    const read = liveSrc.slice(liveSrc.indexOf("async function performPaneRead"), liveSrc.indexOf("function startPaneRead"));
    expect(read).toContain("shouldPullStatus(!same, Date.now(), state.snapshotAt)");
    expect(liveSrc).toContain("state.snapshotAt = Date.now()");
  });
});

describe("poke refresh router", () => {
  const rows: Array<{
    screen: "home" | "pane" | "workspace" | "settings" | "computers" | "board";
    openPaneId: string;
    pokePaneId?: string;
    want: "snapshot" | "paneread" | "ignore";
  }> = [
    { screen: "home", openPaneId: "", want: "snapshot" },
    { screen: "home", openPaneId: "", pokePaneId: "p1", want: "snapshot" },
    { screen: "settings", openPaneId: "p1", pokePaneId: "p1", want: "snapshot" },
    { screen: "workspace", openPaneId: "p1", pokePaneId: "p1", want: "snapshot" },
    { screen: "computers", openPaneId: "p1", pokePaneId: "p1", want: "snapshot" },
    { screen: "board", openPaneId: "p1", pokePaneId: "p1", want: "snapshot" },
    { screen: "board", openPaneId: "", pokePaneId: "p2", want: "snapshot" },
    { screen: "pane", openPaneId: "p1", pokePaneId: "p1", want: "paneread" },
    { screen: "pane", openPaneId: "p1", pokePaneId: "p2", want: "ignore" },
    { screen: "pane", openPaneId: "p1", want: "ignore" },
    { screen: "pane", openPaneId: "", pokePaneId: "p1", want: "snapshot" },
  ];

  for (const row of rows) {
    test(`${row.screen} open=${row.openPaneId || "none"} poke=${row.pokePaneId ?? "none"} → ${row.want}`, () => {
      expect(pokeRefreshAction(row.screen, row.openPaneId, row.pokePaneId)).toBe(row.want);
    });
  }

  test("Herdr availability transitions refresh configuration before screen data", () => {
    expect(pokeRefreshAction("pane", "p1", undefined, "herdr_offline")).toBe("runtime");
    expect(pokeRefreshAction("pane", "p1", undefined, "herdr_online")).toBe("runtime");
    const recovery = liveSrc.slice(
      liveSrc.indexOf("export async function refreshRuntimeState"),
      liveSrc.indexOf("async function handleTerminal"),
    );
    expect(recovery.indexOf("await refreshHerdConfig()"))
      .toBeLessThan(recovery.indexOf("await refreshFromSession()"));
  });
});
