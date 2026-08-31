import { LiveInputPump } from "../src/ui/session/live-input";

type Timer = { at: number; run: () => void; cancelled: boolean };
type Ack = { at: number; resolve: () => void };

const INPUT_EVENTS = 180;
const INPUT_INTERVAL_MS = 6;
const CHARS_PER_EVENT = 12;
const PAINT_MS = 16;

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function scenario(rttMs: number) {
  let now = 0;
  let nextInput = 0;
  let firstLocalStateMs: number | null = null;
  let firstReadSentAt: number | null = null;
  const timers: Timer[] = [];
  const acknowledgements: Ack[] = [];
  const batches: number[] = [];

  const pump = new LiveInputPump({
    schedule: (run) => {
      const timer = { at: now + PAINT_MS, run, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => { (handle as Timer).cancelled = true; },
    send: (text) => {
      batches.push(text.length);
      return new Promise<void>((resolve) => acknowledgements.push({ at: now + rttMs, resolve }));
    },
    requestRead: () => {
      firstReadSentAt ??= now;
    },
    onChange: (state) => {
      if (state.visibleText && firstLocalStateMs === null) firstLocalStateMs = now;
    },
    onError: (error) => { throw error; },
  });

  while (nextInput < INPUT_EVENTS || timers.some((timer) => !timer.cancelled) || acknowledgements.length) {
    const inputAt = nextInput < INPUT_EVENTS ? nextInput * INPUT_INTERVAL_MS : Number.POSITIVE_INFINITY;
    const timerAt = Math.min(...timers.filter((timer) => !timer.cancelled).map((timer) => timer.at), Number.POSITIVE_INFINITY);
    const ackAt = acknowledgements[0]?.at ?? Number.POSITIVE_INFINITY;
    const nextAt = Math.min(inputAt, timerAt, ackAt);
    if (!Number.isFinite(nextAt)) break;
    now = nextAt;

    if (ackAt === nextAt) {
      acknowledgements.shift()!.resolve();
      await microtasks();
      continue;
    }
    if (timerAt === nextAt) {
      const timer = timers.find((item) => !item.cancelled && item.at === timerAt)!;
      timer.cancelled = true;
      timer.run();
      continue;
    }
    pump.enqueue("x".repeat(CHARS_PER_EVENT));
    nextInput++;
  }

  return {
    rttMs,
    inputEvents: INPUT_EVENTS,
    sentBatches: batches.length,
    localStateFeedbackMs: firstLocalStateMs,
    localPaintBudgetMs: PAINT_MS,
    firstRemoteScreenMs: (firstReadSentAt ?? 0) + rttMs,
    legacyFirstRemoteScreenMs: 55 + 2 * rttMs,
    firstScreenReductionMs: 55 + 2 * rttMs - ((firstReadSentAt ?? 0) + rttMs),
    completionMs: now,
    batchChars: { min: Math.min(...batches), max: Math.max(...batches) },
  };
}

const scenarios = [];
for (const rttMs of [80, 180, 350]) scenarios.push(await scenario(rttMs));
console.log(JSON.stringify({
  benchmark: "pairfob-guided-live-input",
  model: {
    inputEvents: INPUT_EVENTS,
    inputIntervalMs: INPUT_INTERVAL_MS,
    charsPerEvent: CHARS_PER_EVENT,
    firstBatchPaintMs: PAINT_MS,
    note: "virtual RTT; remote-screen timing assumes ordered SendText then PaneRead on the same established session",
  },
  scenarios,
}, null, 2));
