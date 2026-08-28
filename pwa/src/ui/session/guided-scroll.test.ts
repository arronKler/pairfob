import { describe, expect, test } from "bun:test";

import type { SessionEvent } from "../../lib/protocol/client";
import { GUIDED_SCROLL_IDLE_MS, GuidedScrollController, type GuidedScrollTarget } from "./guided-scroll";

function terminalId(paneId: string): string {
  return `term_${paneId.padEnd(32, "0")}`;
}

function target(calls: Array<Record<string, unknown>>, paneId = "p1"): GuidedScrollTarget {
  return {
    paneId,
    cols: 80,
    rows: 24,
    session: {
      terminalOpen: async (pane, cols, rows, takeover) => {
        calls.push({ op: "open", pane, cols, rows, takeover });
        return { operationId: "op_open", terminalId: terminalId(pane), paneId: pane, cols, rows, encoding: "ansi" };
      },
      terminalScroll: async (terminalId, sequence, direction, lines, source) => {
        calls.push({ op: "scroll", terminalId, sequence, direction, lines, source });
      },
      terminalClose: async (terminalId) => {
        calls.push({ op: "close", terminalId });
      },
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("guided terminal wheel bridge", () => {
  test("uses one real terminal controller and strict wheel sequences for a burst", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const controller = new GuidedScrollController((callback, delay) => {
      timers.push({ callback, delay });
      return timers.length as ReturnType<typeof setTimeout>;
    }, () => undefined);
    const request = target(calls);

    expect(await controller.scroll(request, "up", 3)).toBeTrue();
    expect(await controller.scroll(request, "down", 4)).toBeTrue();
    expect(calls).toEqual([
      { op: "open", pane: "p1", cols: 80, rows: 24, takeover: false },
      { op: "scroll", terminalId: terminalId("p1"), sequence: 1, direction: "up", lines: 3, source: "wheel" },
      { op: "scroll", terminalId: terminalId("p1"), sequence: 2, direction: "down", lines: 4, source: "wheel" },
    ]);
    expect(timers.at(-1)?.delay).toBe(GUIDED_SCROLL_IDLE_MS);
    timers.at(-1)?.callback();
    await flush();
    expect(calls.at(-1)).toEqual({ op: "close", terminalId: terminalId("p1") });
  });

  test("drops matching frames and reopens after the bridge closes", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const controller = new GuidedScrollController(() => 1 as ReturnType<typeof setTimeout>, () => undefined);
    const request = target(calls);
    await controller.scroll(request, "up", 3);
    const openTerminalId = terminalId("p1");

    expect(controller.handleEvent({ type: "terminal_frame", terminalId: openTerminalId } as SessionEvent)).toBeTrue();
    expect(controller.handleEvent({ type: "terminal_frame", terminalId: "term_other" } as SessionEvent)).toBeFalse();
    expect(controller.handleEvent({ type: "terminal_closed", terminalId: openTerminalId } as SessionEvent)).toBeTrue();
    await controller.scroll(request, "down", 3);
    expect(calls.filter((call) => call.op === "open")).toHaveLength(2);
  });

  test("a pane switch releases the old controller without replaying its scroll", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const controller = new GuidedScrollController(() => 1 as ReturnType<typeof setTimeout>, () => undefined);
    await controller.scroll(target(calls, "p1"), "up", 3);
    await controller.scroll(target(calls, "p2"), "down", 3);
    await flush();

    expect(calls.filter((call) => call.op === "scroll")).toEqual([
      { op: "scroll", terminalId: terminalId("p1"), sequence: 1, direction: "up", lines: 3, source: "wheel" },
      { op: "scroll", terminalId: terminalId("p2"), sequence: 1, direction: "down", lines: 3, source: "wheel" },
    ]);
    expect(calls).toContainEqual({ op: "close", terminalId: terminalId("p1") });
  });
});
