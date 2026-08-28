import type { TerminalCommandPumpObserver, TerminalCommandQueueState } from "./full-terminal-command";

export const TERMINAL_PERF_DEBUG_KEY = "pairfob:terminalPerf";
export const TERMINAL_PERF_EVENT = "pairfob:terminal-perf";

const SAMPLE_LIMIT = 128;
const PERF_ENTER_MARK = "pairfob:terminal:entered";
const PERF_BRIDGE_MARK = "pairfob:terminal:bridge-start";
const PERF_COMPONENT_MEASURE = "pairfob:terminal:component-ready";
const PERF_BRIDGE_MEASURE = "pairfob:terminal:bridge-open";
const PERF_FIRST_FRAME_MEASURE = "pairfob:terminal:first-frame";

export type DurationSummary = {
  count: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type TerminalPerfSnapshot = {
  reason: string;
  lifecycle: {
    componentReadyMs: number | null;
    bridgeOpenMs: number | null;
    firstFrameMs: number | null;
  };
  commands: {
    queued: number;
    coalesced: number;
    sent: number;
    settled: number;
    failed: number;
    dropped: number;
    peakPendingCommands: number;
    peakPendingInputBytes: number;
    queueWait: DurationSummary;
    rtt: DurationSummary;
  };
  frames: {
    parts: number;
    logicalFrames: number;
    ingressBytes: number;
    renderedBytes: number;
    peakPendingWriteBytes: number;
    assembly: DurationSummary;
    write: DurationSummary;
  };
};

class DurationWindow {
  private count = 0;
  private total = 0;
  private max = 0;
  private readonly samples: number[] = [];

  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.count++;
    this.total += value;
    this.max = Math.max(this.max, value);
    this.samples.push(value);
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
  }

  reset(): void {
    this.count = 0;
    this.total = 0;
    this.max = 0;
    this.samples.length = 0;
  }

  summary(): DurationSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (value: number): number => {
      if (!sorted.length) return 0;
      return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)]!;
    };
    return {
      count: this.count,
      averageMs: this.count ? this.total / this.count : 0,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: this.max,
    };
  }
}

function droppedCount(state: TerminalCommandQueueState): number {
  return state.commands;
}

/** Bounded, content-free metrics for terminal tracing and local device QA. */
export class TerminalPerfTracker {
  private readonly now: () => number;
  private active = false;
  private enteredAt = 0;
  private bridgeStartedAt: number | null = null;
  private componentReadyMs: number | null = null;
  private bridgeOpenMs: number | null = null;
  private firstFrameMs: number | null = null;
  private commandQueued = 0;
  private commandCoalesced = 0;
  private commandSent = 0;
  private commandSettled = 0;
  private commandFailed = 0;
  private commandDropped = 0;
  private peakPendingCommands = 0;
  private peakPendingInputBytes = 0;
  private frameParts = 0;
  private logicalFrames = 0;
  private ingressBytes = 0;
  private renderedBytes = 0;
  private peakPendingWriteBytes = 0;
  private readonly queueWait = new DurationWindow();
  private readonly commandRTT = new DurationWindow();
  private readonly assembly = new DurationWindow();
  private readonly write = new DurationWindow();

  readonly commandObserver: TerminalCommandPumpObserver = {
    queued: (_kind, coalesced, state) => {
      this.commandQueued++;
      if (coalesced) this.commandCoalesced++;
      this.observePending(state);
    },
    sent: (_kind, _sequence, queueWaitMs, state) => {
      this.commandSent++;
      this.queueWait.record(queueWaitMs);
      this.observePending(state);
    },
    settled: (_kind, _sequence, rttMs, state) => {
      this.commandSettled++;
      this.commandRTT.record(rttMs);
      this.observePending(state);
    },
    failed: (_kind, _sequence, rttMs, dropped) => {
      this.commandFailed++;
      this.commandDropped += droppedCount(dropped);
      this.commandRTT.record(rttMs);
    },
    stopped: (dropped) => {
      this.commandDropped += droppedCount(dropped);
    },
  };

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  begin(): void {
    this.active = true;
    this.enteredAt = this.now();
    this.bridgeStartedAt = null;
    this.componentReadyMs = null;
    this.bridgeOpenMs = null;
    this.firstFrameMs = null;
    this.commandQueued = 0;
    this.commandCoalesced = 0;
    this.commandSent = 0;
    this.commandSettled = 0;
    this.commandFailed = 0;
    this.commandDropped = 0;
    this.peakPendingCommands = 0;
    this.peakPendingInputBytes = 0;
    this.frameParts = 0;
    this.logicalFrames = 0;
    this.ingressBytes = 0;
    this.renderedBytes = 0;
    this.peakPendingWriteBytes = 0;
    this.queueWait.reset();
    this.commandRTT.reset();
    this.assembly.reset();
    this.write.reset();
    this.clearLifecycleEntries();
    this.mark(PERF_ENTER_MARK);
  }

  componentReady(): void {
    if (this.componentReadyMs !== null || !this.active) return;
    this.componentReadyMs = Math.max(0, this.now() - this.enteredAt);
    this.measure(PERF_COMPONENT_MEASURE, PERF_ENTER_MARK);
  }

  bridgeStarted(): void {
    this.bridgeStartedAt = this.now();
    this.mark(PERF_BRIDGE_MARK);
  }

  bridgeOpened(): void {
    if (this.bridgeStartedAt === null) return;
    this.bridgeOpenMs = Math.max(0, this.now() - this.bridgeStartedAt);
    this.measure(PERF_BRIDGE_MEASURE, PERF_BRIDGE_MARK);
  }

  framePart(bytes: number): void {
    this.frameParts++;
    this.ingressBytes += Math.max(0, bytes);
  }

  frameAssembled(durationMs: number): void {
    this.logicalFrames++;
    this.assembly.record(durationMs);
    if (this.firstFrameMs === null && this.active) {
      this.firstFrameMs = Math.max(0, this.now() - this.enteredAt);
      this.measure(PERF_FIRST_FRAME_MEASURE, PERF_ENTER_MARK);
    }
  }

  writeStarted(bytes: number, pendingBytes: number): void {
    this.renderedBytes += Math.max(0, bytes);
    this.peakPendingWriteBytes = Math.max(this.peakPendingWriteBytes, pendingBytes);
  }

  writeCompleted(durationMs: number): void {
    this.write.record(durationMs);
  }

  snapshot(reason = "snapshot"): TerminalPerfSnapshot {
    return {
      reason,
      lifecycle: {
        componentReadyMs: this.componentReadyMs,
        bridgeOpenMs: this.bridgeOpenMs,
        firstFrameMs: this.firstFrameMs,
      },
      commands: {
        queued: this.commandQueued,
        coalesced: this.commandCoalesced,
        sent: this.commandSent,
        settled: this.commandSettled,
        failed: this.commandFailed,
        dropped: this.commandDropped,
        peakPendingCommands: this.peakPendingCommands,
        peakPendingInputBytes: this.peakPendingInputBytes,
        queueWait: this.queueWait.summary(),
        rtt: this.commandRTT.summary(),
      },
      frames: {
        parts: this.frameParts,
        logicalFrames: this.logicalFrames,
        ingressBytes: this.ingressBytes,
        renderedBytes: this.renderedBytes,
        peakPendingWriteBytes: this.peakPendingWriteBytes,
        assembly: this.assembly.summary(),
        write: this.write.summary(),
      },
    };
  }

  publish(reason: string): TerminalPerfSnapshot {
    const snapshot = this.snapshot(reason);
    if (typeof document !== "undefined") {
      const EventConstructor = document.defaultView?.CustomEvent;
      if (EventConstructor) {
        document.dispatchEvent(new EventConstructor(TERMINAL_PERF_EVENT, { detail: snapshot }));
      }
    }
    try {
      if (localStorage.getItem(TERMINAL_PERF_DEBUG_KEY) === "1") console.info("[Pairfob terminal perf]", snapshot);
    } catch {
      /* storage can be unavailable in private mode */
    }
    return snapshot;
  }

  private observePending(state: TerminalCommandQueueState): void {
    this.peakPendingCommands = Math.max(this.peakPendingCommands, state.commands);
    this.peakPendingInputBytes = Math.max(this.peakPendingInputBytes, state.inputBytes);
  }

  private clearLifecycleEntries(): void {
    if (typeof performance === "undefined") return;
    for (const name of [PERF_ENTER_MARK, PERF_BRIDGE_MARK]) performance.clearMarks(name);
    for (const name of [PERF_COMPONENT_MEASURE, PERF_BRIDGE_MEASURE, PERF_FIRST_FRAME_MEASURE]) {
      performance.clearMeasures(name);
    }
  }

  private mark(name: string): void {
    try {
      performance.mark(name);
    } catch {
      /* Performance Timeline is optional; counters remain available. */
    }
  }

  private measure(name: string, startMark: string): void {
    try {
      performance.clearMeasures(name);
      performance.measure(name, startMark);
    } catch {
      /* A missing mark must not affect terminal behavior. */
    }
  }
}

export const fullTerminalPerf = new TerminalPerfTracker();
