import { describe, expect, test } from "bun:test";

import { TerminalPerfTracker } from "./full-terminal-perf";

describe("TerminalPerfTracker", () => {
  test("records bounded content-free lifecycle, command and frame metrics", () => {
    let now = 100;
    const perf = new TerminalPerfTracker(() => now);
    perf.begin();
    now = 125;
    perf.componentReady();
    perf.bridgeStarted();
    now = 175;
    perf.bridgeOpened();
    perf.commandObserver.queued?.("input", false, { commands: 1, inputBytes: 3 });
    perf.commandObserver.queued?.("input", true, { commands: 2, inputBytes: 7 });
    perf.commandObserver.sent?.("input", 1, 40, { commands: 2, inputBytes: 7 });
    perf.commandObserver.settled?.("input", 1, 150, { commands: 1, inputBytes: 4 });
    perf.framePart(96);
    now = 300;
    const marker = perf.frameAssembled(2);
    perf.writeStarted(96, 96);
    now = 310;
    perf.writeCompleted(8, marker);

    const snapshot = perf.snapshot("test");
    expect(snapshot.lifecycle).toEqual({ componentReadyMs: 25, bridgeOpenMs: 50, firstFrameMs: 200 });
    expect(snapshot.commands).toMatchObject({
      queued: 2,
      coalesced: 1,
      sent: 1,
      settled: 1,
      failed: 0,
      dropped: 0,
      peakPendingCommands: 2,
      peakPendingInputBytes: 7,
    });
    expect(snapshot.commands.queueWait).toEqual({ count: 1, averageMs: 40, p50Ms: 40, p95Ms: 40, maxMs: 40 });
    expect(snapshot.commands.rtt).toEqual({ count: 1, averageMs: 150, p50Ms: 150, p95Ms: 150, maxMs: 150 });
    expect(snapshot.frames).toMatchObject({
      parts: 1,
      logicalFrames: 1,
      ingressBytes: 96,
      renderedBytes: 96,
      peakPendingWriteBytes: 96,
    });
    expect(snapshot.latency.inputToNextFrame).toEqual({ count: 1, averageMs: 165, p50Ms: 165, p95Ms: 165, maxMs: 165 });
    expect(snapshot.latency.inputToWrite).toEqual({ count: 1, averageMs: 175, p50Ms: 175, p95Ms: 175, maxMs: 175 });
  });

  test("retains only a bounded latency sample window while preserving totals", () => {
    const perf = new TerminalPerfTracker(() => 1);
    perf.begin();
    for (let value = 1; value <= 200; value++) {
      perf.commandObserver.sent?.("input", value, value, { commands: 1, inputBytes: 1 });
    }
    const summary = perf.snapshot().commands.queueWait;
    expect(summary.count).toBe(200);
    expect(summary.averageMs).toBe(100.5);
    expect(summary.p50Ms).toBe(136);
    expect(summary.p95Ms).toBe(194);
    expect(summary.maxMs).toBe(200);
  });

  test("counts only unsent commands as dropped on failure", () => {
    const perf = new TerminalPerfTracker(() => 1);
    perf.begin();
    perf.commandObserver.failed?.("input", 1, 120, { commands: 2, inputBytes: 4 });
    const commands = perf.snapshot().commands;
    expect(commands.failed).toBe(1);
    expect(commands.dropped).toBe(2);
    expect(commands.rtt.p95Ms).toBe(120);
  });

  test("does not attribute a later frame to input dropped by a stopped pump", () => {
    let now = 10;
    const perf = new TerminalPerfTracker(() => now);
    perf.begin();
    perf.commandObserver.queued?.("input", false, { commands: 1, inputBytes: 1 });
    perf.commandObserver.sent?.("input", 1, 0, { commands: 1, inputBytes: 1 });
    perf.commandObserver.stopped?.({ commands: 1, inputBytes: 1 });
    now = 200;
    const marker = perf.frameAssembled(1);
    perf.writeCompleted(1, marker);
    expect(perf.snapshot().latency.inputToNextFrame.count).toBe(0);
    expect(perf.snapshot().latency.inputToWrite.count).toBe(0);
  });
});
