import { TERMINAL_INPUT_CHUNK } from "../lib/protocol/terminal";

export type TerminalInputCommand = { kind: "input"; data: Uint8Array };
export type TerminalResizeCommand = {
  kind: "resize";
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
};
export type TerminalScrollCommand = {
  kind: "scroll";
  direction: "up" | "down";
  lines: number;
  source: "wheel" | "page_key";
  at?: { column: number; row: number };
};
export type TerminalCommand = TerminalInputCommand | TerminalResizeCommand | TerminalScrollCommand;

export type TerminalCommandQueueState = {
  commands: number;
  inputBytes: number;
};

export type TerminalInputQueueOptions = {
  isolate?: boolean;
};

export type TerminalCommandPumpObserver = {
  queued?: (kind: TerminalCommand["kind"], coalesced: boolean, state: TerminalCommandQueueState) => void;
  sent?: (
    kind: TerminalCommand["kind"],
    sequence: number,
    queueWaitMs: number,
    state: TerminalCommandQueueState,
  ) => void;
  settled?: (
    kind: TerminalCommand["kind"],
    sequence: number,
    rttMs: number,
    state: TerminalCommandQueueState,
  ) => void;
  failed?: (
    kind: TerminalCommand["kind"],
    sequence: number,
    rttMs: number,
    dropped: TerminalCommandQueueState,
  ) => void;
  stopped?: (dropped: TerminalCommandQueueState) => void;
};

type QueuedCommand = {
  command: TerminalCommand;
  queuedAt: number;
  mergeInput: boolean;
};

type InFlightCommand = QueuedCommand & {
  sequence: number;
  sentAt: number;
};

export type TerminalCommandPumpOptions = {
  execute: (command: TerminalCommand, sequence: number) => Promise<unknown>;
  onError: (error: unknown) => void;
  now?: () => number;
  observer?: TerminalCommandPumpObserver;
};

/**
 * Keep one terminal mutation in flight while coalescing work that has not been
 * sent. This bounds mobile RTT amplification without replaying an uncertain
 * command or changing the server's strict sequence contract.
 */
export class TerminalCommandPump {
  private readonly execute: TerminalCommandPumpOptions["execute"];
  private readonly onError: TerminalCommandPumpOptions["onError"];
  private readonly now: () => number;
  private readonly observer?: TerminalCommandPumpObserver;
  private readonly queue: QueuedCommand[] = [];
  private queuedInputBytes = 0;
  private inFlight: InFlightCommand | null = null;
  private nextSequence = 1;
  private stopped = false;

  constructor(options: TerminalCommandPumpOptions) {
    this.execute = options.execute;
    this.onError = options.onError;
    this.now = options.now ?? (() => performance.now());
    this.observer = options.observer;
  }

  enqueueInput(data: Uint8Array, options: TerminalInputQueueOptions = {}): void {
    if (this.stopped || data.byteLength === 0) return;
    const mergeInput = options.isolate !== true;
    let offset = 0;
    while (offset < data.byteLength) {
      const tail = this.queue[this.queue.length - 1];
      if (mergeInput && tail?.mergeInput && tail.command.kind === "input" && tail.command.data.byteLength < TERMINAL_INPUT_CHUNK) {
        const take = Math.min(TERMINAL_INPUT_CHUNK - tail.command.data.byteLength, data.byteLength - offset);
        const combined = new Uint8Array(tail.command.data.byteLength + take);
        combined.set(tail.command.data);
        combined.set(data.subarray(offset, offset + take), tail.command.data.byteLength);
        tail.command = { kind: "input", data: combined };
        this.queuedInputBytes += take;
        offset += take;
        this.observer?.queued?.("input", true, this.state());
        continue;
      }
      const take = Math.min(TERMINAL_INPUT_CHUNK, data.byteLength - offset);
      this.enqueue({ kind: "input", data: data.slice(offset, offset + take) }, mergeInput);
      offset += take;
    }
  }

  enqueueResize(command: Omit<TerminalResizeCommand, "kind">): void {
    if (this.stopped) return;
    const tail = this.queue[this.queue.length - 1];
    if (tail?.command.kind === "resize") {
      tail.command = { kind: "resize", ...command };
      tail.queuedAt = this.now();
      this.observer?.queued?.("resize", true, this.state());
      return;
    }
    this.enqueue({ kind: "resize", ...command });
  }

  enqueueScroll(command: Omit<TerminalScrollCommand, "kind">): void {
    if (this.stopped) return;
    this.enqueue({ kind: "scroll", ...command });
  }

  stop(): void {
    if (this.stopped) return;
    const dropped = this.queuedState();
    this.stopped = true;
    this.queue.length = 0;
    this.queuedInputBytes = 0;
    this.inFlight = null;
    this.observer?.stopped?.(dropped);
  }

  snapshot(): TerminalCommandQueueState {
    return this.state();
  }

  private enqueue(command: TerminalCommand, mergeInput = true): void {
    this.queue.push({ command, queuedAt: this.now(), mergeInput });
    if (command.kind === "input") this.queuedInputBytes += command.data.byteLength;
    this.observer?.queued?.(command.kind, false, this.state());
    this.drain();
  }

  private drain(): void {
    if (this.stopped || this.inFlight || this.queue.length === 0) return;
    const queued = this.queue.shift()!;
    if (queued.command.kind === "input") this.queuedInputBytes -= queued.command.data.byteLength;
    const sentAt = this.now();
    const current: InFlightCommand = {
      ...queued,
      sequence: this.nextSequence++,
      sentAt,
    };
    this.inFlight = current;
    this.observer?.sent?.(
      current.command.kind,
      current.sequence,
      Math.max(0, sentAt - current.queuedAt),
      this.state(),
    );

    let request: Promise<unknown>;
    try {
      request = this.execute(current.command, current.sequence);
    } catch (error) {
      this.fail(current, error);
      return;
    }
    void request.then(
      () => this.settle(current),
      (error) => this.fail(current, error),
    );
  }

  private settle(current: InFlightCommand): void {
    if (this.stopped || this.inFlight !== current) return;
    this.inFlight = null;
    this.observer?.settled?.(
      current.command.kind,
      current.sequence,
      Math.max(0, this.now() - current.sentAt),
      this.state(),
    );
    this.drain();
  }

  private fail(current: InFlightCommand, error: unknown): void {
    if (this.stopped || this.inFlight !== current) return;
    const dropped = this.queuedState();
    this.stopped = true;
    this.queue.length = 0;
    this.queuedInputBytes = 0;
    this.inFlight = null;
    this.observer?.failed?.(
      current.command.kind,
      current.sequence,
      Math.max(0, this.now() - current.sentAt),
      dropped,
    );
    this.onError(error);
  }

  private queuedState(): TerminalCommandQueueState {
    return { commands: this.queue.length, inputBytes: this.queuedInputBytes };
  }

  private state(): TerminalCommandQueueState {
    const queued = this.queuedState();
    return {
      commands: queued.commands + (this.inFlight ? 1 : 0),
      inputBytes: queued.inputBytes + (this.inFlight?.command.kind === "input" ? this.inFlight.command.data.byteLength : 0),
    };
  }
}
