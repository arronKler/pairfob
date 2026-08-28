import { TERMINAL_INPUT_CHUNK } from "../src/lib/protocol/terminal";
import { TerminalCommandPump, type TerminalCommandQueueState } from "../src/ui/full-terminal-command";

type PendingAcknowledgement = {
  at: number;
  resolve: () => void;
};

type ScenarioResult = {
  rttMs: number;
  inputEvents: number;
  inputBytes: number;
  sentCommands: number;
  coalescedEvents: number;
  completionMs: number;
  serializedBaselineMs: number;
  completionReductionPercent: number;
  peakPendingCommands: number;
  peakPendingInputBytes: number;
  batchBytes: { min: number; median: number; p95: number; max: number };
  queueWaitMs: { median: number; p95: number; max: number };
};

const INPUT_EVENTS = 180;
const INPUT_INTERVAL_MS = 6;
const BYTES_PER_EVENT = 12;

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}

function summary(values: number[]): { median: number; p95: number; max: number } {
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : 0,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function runScenario(rttMs: number): Promise<ScenarioResult> {
  let now = 0;
  let nextInput = 0;
  let pendingAcknowledgement: PendingAcknowledgement | null = null;
  let coalescedEvents = 0;
  let peakPendingCommands = 0;
  let peakPendingInputBytes = 0;
  const batches: number[] = [];
  const queueWaits: number[] = [];
  const sequences: number[] = [];

  const observePending = (state: TerminalCommandQueueState): void => {
    peakPendingCommands = Math.max(peakPendingCommands, state.commands);
    peakPendingInputBytes = Math.max(peakPendingInputBytes, state.inputBytes);
  };
  const pump = new TerminalCommandPump({
    now: () => now,
    execute: (command, sequence) => {
      if (pendingAcknowledgement) throw new Error("more than one terminal command is in flight");
      if (command.kind !== "input") throw new Error("benchmark only emits input commands");
      batches.push(command.data.byteLength);
      sequences.push(sequence);
      return new Promise<void>((resolve) => {
        pendingAcknowledgement = { at: now + rttMs, resolve };
      });
    },
    onError: (error) => {
      throw error;
    },
    observer: {
      queued: (_kind, coalesced, state) => {
        if (coalesced) coalescedEvents++;
        observePending(state);
      },
      sent: (_kind, _sequence, queueWaitMs, state) => {
        queueWaits.push(queueWaitMs);
        observePending(state);
      },
    },
  });

  while (nextInput < INPUT_EVENTS || pendingAcknowledgement) {
    const nextInputAt = nextInput < INPUT_EVENTS ? nextInput * INPUT_INTERVAL_MS : Number.POSITIVE_INFINITY;
    const nextAcknowledgementAt = pendingAcknowledgement?.at ?? Number.POSITIVE_INFINITY;
    if (nextAcknowledgementAt <= nextInputAt) {
      now = nextAcknowledgementAt;
      const acknowledgement = pendingAcknowledgement;
      pendingAcknowledgement = null;
      acknowledgement.resolve();
      await flushMicrotasks();
      continue;
    }
    now = nextInputAt;
    pump.enqueueInput(new Uint8Array(BYTES_PER_EVENT));
    nextInput++;
  }

  if (batches.some((bytes) => bytes > TERMINAL_INPUT_CHUNK)) {
    throw new Error(`input batch exceeded ${TERMINAL_INPUT_CHUNK} bytes`);
  }
  if (sequences.some((sequence, index) => sequence !== index + 1)) {
    throw new Error("terminal command sequence is not contiguous");
  }
  const serializedBaselineMs = INPUT_EVENTS * rttMs;
  return {
    rttMs,
    inputEvents: INPUT_EVENTS,
    inputBytes: INPUT_EVENTS * BYTES_PER_EVENT,
    sentCommands: batches.length,
    coalescedEvents,
    completionMs: now,
    serializedBaselineMs,
    completionReductionPercent: Math.round((1 - now / serializedBaselineMs) * 1_000) / 10,
    peakPendingCommands,
    peakPendingInputBytes,
    batchBytes: {
      min: Math.min(...batches),
      ...summary(batches),
    },
    queueWaitMs: summary(queueWaits),
  };
}

const scenarios = [];
for (const rttMs of [80, 180, 350]) scenarios.push(await runScenario(rttMs));
console.log(JSON.stringify({
  benchmark: "pairfob-terminal-command-pump",
  model: {
    inputEvents: INPUT_EVENTS,
    inputIntervalMs: INPUT_INTERVAL_MS,
    bytesPerEvent: BYTES_PER_EVENT,
    note: "virtual clock; serialized baseline is the former one-RPC-per-event queue",
  },
  scenarios,
}, null, 2));
