import { describe, expect, test } from "bun:test";

import { TERMINAL_INPUT_CHUNK } from "../../../lib/protocol/terminal";
import { TerminalCommandPump, type TerminalCommand } from "./full-terminal-command";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalCommandPump", () => {
  test("sends one command immediately and coalesces unsent input", async () => {
    const requests: Array<{ command: TerminalCommand; sequence: number; done: Deferred }> = [];
    const pump = new TerminalCommandPump({
      execute: (command, sequence) => {
        const done = deferred();
        requests.push({ command, sequence, done });
        return done.promise;
      },
      onError: () => undefined,
    });

    pump.enqueueInput(new Uint8Array([1]));
    pump.enqueueInput(new Uint8Array([2]));
    pump.enqueueInput(new Uint8Array([3, 4]));
    expect(requests).toHaveLength(1);
    expect(requests[0].sequence).toBe(1);
    expect(requests[0].command).toEqual({ kind: "input", data: new Uint8Array([1]) });
    expect(pump.snapshot()).toEqual({ commands: 2, inputBytes: 4 });

    requests[0].done.resolve();
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].sequence).toBe(2);
    expect(requests[1].command).toEqual({ kind: "input", data: new Uint8Array([2, 3, 4]) });
  });

  test("keeps a non-coalescing input boundary behind queued text", async () => {
    const requests: Array<{ command: TerminalCommand; sequence: number; done: Deferred }> = [];
    const pump = new TerminalCommandPump({
      execute: (command, sequence) => {
        const done = deferred();
        requests.push({ command, sequence, done });
        return done.promise;
      },
      onError: () => undefined,
    });

    pump.enqueueInput(new Uint8Array([1]));
    pump.enqueueInput(new Uint8Array([2, 3]));
    pump.enqueueInput(new Uint8Array([0x0d]), { isolate: true });
    pump.enqueueInput(new Uint8Array([4]));
    expect(requests).toHaveLength(1);

    requests[0].done.resolve();
    await flush();
    expect(requests[1].command).toEqual({ kind: "input", data: new Uint8Array([2, 3]) });
    requests[1].done.resolve();
    await flush();
    expect(requests[2].command).toEqual({ kind: "input", data: new Uint8Array([0x0d]) });
    requests[2].done.resolve();
    await flush();
    expect(requests[3].command).toEqual({ kind: "input", data: new Uint8Array([4]) });
    expect(requests.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
  });

  test("keeps only the latest adjacent resize while preserving command order", async () => {
    const requests: Array<{ command: TerminalCommand; sequence: number; done: Deferred }> = [];
    const pump = new TerminalCommandPump({
      execute: (command, sequence) => {
        const done = deferred();
        requests.push({ command, sequence, done });
        return done.promise;
      },
      onError: () => undefined,
    });

    pump.enqueueInput(new Uint8Array([1]));
    pump.enqueueResize({ cols: 80, rows: 20, cellWidth: 5, cellHeight: 10 });
    pump.enqueueResize({ cols: 90, rows: 24, cellWidth: 6, cellHeight: 11 });
    pump.enqueueInput(new Uint8Array([2]));

    requests[0].done.resolve();
    await flush();
    expect(requests[1].command).toEqual({
      kind: "resize", cols: 90, rows: 24, cellWidth: 6, cellHeight: 11,
    });
    requests[1].done.resolve();
    await flush();
    expect(requests[2].command).toEqual({ kind: "input", data: new Uint8Array([2]) });
    expect(requests.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  test("splits large input without exceeding the frozen command limit", async () => {
    const requests: Array<{ command: TerminalCommand; done: Deferred }> = [];
    const pump = new TerminalCommandPump({
      execute: (command) => {
        const done = deferred();
        requests.push({ command, done });
        return done.promise;
      },
      onError: () => undefined,
    });
    const input = new Uint8Array(TERMINAL_INPUT_CHUNK + 5).fill(7);
    pump.enqueueInput(input);
    pump.enqueueInput(new Uint8Array([8, 9]));

    expect(requests[0].command.kind).toBe("input");
    if (requests[0].command.kind === "input") expect(requests[0].command.data.byteLength).toBe(TERMINAL_INPUT_CHUNK);
    requests[0].done.resolve();
    await flush();
    expect(requests[1].command).toEqual({ kind: "input", data: new Uint8Array([7, 7, 7, 7, 7, 8, 9]) });
  });

  test("drops unsent commands after an uncertain failure and never replays them", async () => {
    const requests: Array<{ command: TerminalCommand; done: Deferred }> = [];
    const errors: unknown[] = [];
    const pump = new TerminalCommandPump({
      execute: (command) => {
        const done = deferred();
        requests.push({ command, done });
        return done.promise;
      },
      onError: (error) => errors.push(error),
    });

    pump.enqueueInput(new Uint8Array([1]));
    pump.enqueueInput(new Uint8Array([2]));
    requests[0].done.reject(new Error("unknown outcome"));
    await flush();
    pump.enqueueInput(new Uint8Array([3]));

    expect(requests).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(pump.snapshot()).toEqual({ commands: 0, inputBytes: 0 });
  });

  test("stop discards queued work and ignores a late acknowledgement", async () => {
    const requests: Deferred[] = [];
    const pump = new TerminalCommandPump({
      execute: () => {
        const done = deferred();
        requests.push(done);
        return done.promise;
      },
      onError: () => undefined,
    });
    pump.enqueueInput(new Uint8Array([1]));
    pump.enqueueInput(new Uint8Array([2]));
    pump.stop();
    requests[0].resolve();
    await flush();
    expect(requests).toHaveLength(1);
    expect(pump.snapshot()).toEqual({ commands: 0, inputBytes: 0 });
  });

  test("reports queue wait and RTT without retaining terminal bytes", async () => {
    let now = 0;
    const waits: number[] = [];
    const rtts: number[] = [];
    const requests: Deferred[] = [];
    const pump = new TerminalCommandPump({
      now: () => now,
      execute: () => {
        const done = deferred();
        requests.push(done);
        return done.promise;
      },
      onError: () => undefined,
      observer: {
        sent: (_kind, _sequence, wait) => waits.push(wait),
        settled: (_kind, _sequence, rtt) => rtts.push(rtt),
      },
    });

    pump.enqueueInput(new Uint8Array([1]));
    now = 10;
    pump.enqueueInput(new Uint8Array([2]));
    now = 150;
    requests[0].resolve();
    await flush();
    now = 300;
    requests[1].resolve();
    await flush();

    expect(waits).toEqual([0, 140]);
    expect(rtts).toEqual([150, 150]);
  });
});

describe("TerminalCommandPump scrolls", () => {
  function scrollHarness() {
    const sent: TerminalCommand[] = [];
    const acks: Deferred[] = [];
    const pump = new TerminalCommandPump({
      execute: (command) => {
        const done = deferred();
        sent.push(command);
        acks.push(done);
        return done.promise;
      },
      onError: () => undefined,
    });
    return { pump, sent, acks };
  }

  test("a flick sends where the finger is now, not every step it passed", async () => {
    const { pump, sent, acks } = scrollHarness();
    const at = (row: number) => ({ column: 3, row });

    pump.enqueueScroll({ direction: "down", lines: 1, source: "wheel", at: at(1) });
    for (let row = 2; row <= 6; row++) {
      pump.enqueueScroll({ direction: "down", lines: 1, source: "wheel", at: at(row) });
    }
    expect(sent).toHaveLength(1);
    expect(pump.snapshot().commands).toBe(2);

    acks[0].resolve();
    await flush();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ kind: "scroll", direction: "down", lines: 5, source: "wheel", at: at(6) });
    expect(pump.snapshot().commands).toBe(1);
  });

  test("travel that reverses before it is sent cancels itself out", async () => {
    const { pump, sent, acks } = scrollHarness();

    pump.enqueueInput(new Uint8Array([1]));
    pump.enqueueScroll({ direction: "up", lines: 1, source: "wheel" });
    pump.enqueueScroll({ direction: "up", lines: 2, source: "wheel" });
    pump.enqueueScroll({ direction: "down", lines: 3, source: "wheel" });
    expect(pump.snapshot().commands).toBe(1);

    acks[0].resolve();
    await flush();
    expect(sent).toHaveLength(1);
    expect(pump.snapshot().commands).toBe(0);
  });

  test("a page step is its own command, not wheel travel that merges", async () => {
    const { pump, sent, acks } = scrollHarness();

    pump.enqueueScroll({ direction: "down", lines: 1, source: "wheel" });
    pump.enqueueScroll({ direction: "down", lines: 8, source: "page_key" });
    pump.enqueueScroll({ direction: "down", lines: 8, source: "page_key" });
    expect(pump.snapshot().commands).toBe(3);

    acks[0].resolve();
    await flush();
    acks[1].resolve();
    await flush();

    expect(sent.slice(1)).toEqual([
      { kind: "scroll", direction: "down", lines: 8, source: "page_key" },
      { kind: "scroll", direction: "down", lines: 8, source: "page_key" },
    ]);
  });

  test("merged travel stays within what the daemon accepts as one scroll", async () => {
    const { pump, sent, acks } = scrollHarness();

    pump.enqueueScroll({ direction: "down", lines: 40, source: "wheel" });
    for (let step = 0; step < 6; step += 1) {
      pump.enqueueScroll({ direction: "down", lines: 40, source: "wheel" });
    }
    acks[0].resolve();
    await flush();

    expect(sent[1]).toEqual({ kind: "scroll", direction: "down", lines: 160, source: "wheel", at: undefined });
  });
});
