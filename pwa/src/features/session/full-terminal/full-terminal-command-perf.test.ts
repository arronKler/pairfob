import { expect, test } from "bun:test";
import { ProtocolError } from "../../../lib/protocol/errors";
import { TerminalCommandPump } from "./full-terminal-command";
import { TerminalPerfTracker } from "./full-terminal-perf";

test("unsupported scrolling settles metrics without dropping queued input or resize", async () => {
  let now = 100;
  const perf = new TerminalPerfTracker(() => now);
  perf.begin();
  let rejectScroll!: (error: Error) => void;
  const sent: { kind: string; sequence: number }[] = [];
  const errors: unknown[] = [];
  const pump = new TerminalCommandPump({
    now: () => now,
    observer: perf.commandObserver,
    execute: (command, sequence) => {
      sent.push({ kind: command.kind, sequence });
      return command.kind === "scroll"
        ? new Promise((_, reject) => { rejectScroll = reject; })
        : Promise.resolve();
    },
    onError: error => errors.push(error),
  });
  const scroll = { direction: "up" as const, lines: 1, source: "page_key" as const };
  pump.enqueueScroll(scroll);
  pump.enqueueScroll(scroll);
  pump.enqueueInput(new Uint8Array([120]));
  pump.enqueueScroll(scroll);
  pump.enqueueResize({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 });
  now = 200;
  rejectScroll(new ProtocolError("unsupported"));
  for (let index = 0; index < 8; index++) await Promise.resolve();

  expect(errors).toEqual([]);
  expect(sent).toEqual([
    { kind: "scroll", sequence: 1 },
    { kind: "input", sequence: 1 },
    { kind: "resize", sequence: 2 },
  ]);
  expect(perf.snapshot().commands).toMatchObject({ sent: 3, settled: 2, failed: 1, dropped: 2 });
  now = 1500;
  const marker = perf.frameAssembled(1);
  perf.writeCompleted(1, marker);
  expect(perf.snapshot().latency.scrollToNextFrame.count).toBe(0);
  expect(perf.snapshot().latency.scrollToWrite.count).toBe(0);
  expect(perf.snapshot().latency.inputToNextFrame.count).toBe(1);
  pump.stop();
});
