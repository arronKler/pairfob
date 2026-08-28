/** Type-then-read-then-Enter. Never auto-retry either mutation. */

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_READS = 80;
const POLL_MS = 150;
const SETTLE_POLL_MS = 1_000;
const FAST_CONFIRM_MS = 5_000;
const MIN_LITERAL_GUARD = 12;
const SCREEN_HASH = /^[0-9a-f]{64}$/;

export type GuardedScreen = {
  text: string;
  hash?: string;
};

export type EnterGuard = {
  expectedPrompt: string;
  expectedSignature: string;
};

export type GuardedOutcome = "sent" | "stalled" | "cancelled";

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function joinWrappedLines(value: string): string {
  return value.replace(/[ \t]*\r?\n[ \t]*/gu, "");
}

function visibleCount(screen: string, needle: string): number {
  if (!needle.trim()) return 0;
  return Math.max(
    countOccurrences(screen, needle),
    countOccurrences(collapseWhitespace(screen), collapseWhitespace(needle)),
    countOccurrences(joinWrappedLines(screen), joinWrappedLines(needle)),
  );
}

function promptSuffix(value: string): string {
  return Array.from(value).slice(-4096).join("");
}

/**
 * TUI inputs commonly scroll horizontally, leaving only the cursor-side tail
 * visible. Prefer the full prompt, but accept progressively smaller substantial
 * tails when that exact tail newly appears after SendText.
 */
function confirmationNeedles(value: string): string[] {
  const chars = Array.from(promptSuffix(value));
  const minimum = Math.min(chars.length, MIN_LITERAL_GUARD);
  const widths = [chars.length, 64, 32, 16, minimum]
    .filter((width, index, all) => width >= minimum && width <= chars.length && all.indexOf(width) === index)
    .sort((a, b) => b - a);
  return widths.map((width) => chars.slice(-width).join(""));
}

/** True when the whole needle is on screen, including common TUI soft wraps. */
export function visibleHas(screen: string, needle: string): boolean {
  return visibleCount(screen, needle) > 0;
}

function candidateStarts(length: number, width: number): number[] {
  const last = length - width;
  const step = Math.max(1, Math.floor(width / 2));
  const starts: number[] = [];
  for (let start = 0; start <= last; start += step) starts.push(start);
  if (starts.at(-1) !== last) starts.push(last);
  return starts;
}

/**
 * Return a substantial literal from the confirmed input for daemon-side
 * strings.Contains. A one-character match is not a safe Enter precondition.
 */
export function promptGuard(screen: string, text: string): string {
  const needle = promptSuffix(text);
  if (!visibleHas(screen, needle)) return "";
  if (screen.includes(needle)) return needle;

  const chars = Array.from(needle);
  const minimum = Math.min(chars.length, MIN_LITERAL_GUARD);
  const widths = [64, 32, 16, minimum]
    .filter((width, index, all) => width >= minimum && width <= chars.length && all.indexOf(width) === index)
    .sort((a, b) => b - a);
  for (const width of widths) {
    for (const start of candidateStarts(chars.length, width)) {
      const candidate = chars.slice(start, start + width).join("");
      if (candidate.trim() && screen.includes(candidate)) return candidate;
    }
  }
  return "";
}

function validHash(value: string | undefined): value is string {
  return typeof value === "string" && SCREEN_HASH.test(value);
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextPollDelay(startedAt: number, deadline: number): number {
  const interval = Date.now() - startedAt < FAST_CONFIRM_MS ? POLL_MS : SETTLE_POLL_MS;
  return Math.min(interval, Math.max(0, deadline - Date.now()));
}

export async function guardedReply(opts: {
  sendText: (text: string) => Promise<void>;
  read: () => Promise<GuardedScreen>;
  sendEnter: (guard: EnterGuard) => Promise<void>;
  text: string;
  wait?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  maxReads?: number;
  isActive?: () => boolean;
  retryRead?: (error: unknown) => boolean;
}): Promise<GuardedOutcome> {
  const baseline = await opts.read();
  if (!validHash(baseline.hash)) throw new Error("pane read did not return a valid screen hash");
  if (opts.isActive && !opts.isActive()) return "cancelled";

  const needles = confirmationNeedles(opts.text).map((needle) => ({
    needle,
    baselineOccurrences: visibleCount(baseline.text, needle),
  }));
  await opts.sendText(opts.text);
  const wait = opts.wait ?? defaultWait;
  const startedAt = Date.now();
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxReads = opts.maxReads ?? DEFAULT_MAX_READS;

  for (let attempt = 0; attempt < maxReads; attempt++) {
    if (opts.isActive && !opts.isActive()) return "stalled";
    let screen: GuardedScreen;
    try {
      screen = await opts.read();
    } catch (error) {
      if (!opts.retryRead?.(error)) throw error;
      if (attempt + 1 >= maxReads || Date.now() >= deadline) return "stalled";
      await wait(nextPollDelay(startedAt, deadline));
      continue;
    }
    if (!validHash(screen.hash)) return "stalled";
    const expectedPrompt = screen.hash === baseline.hash
      ? ""
      : needles
          .filter(({ needle, baselineOccurrences }) => visibleCount(screen.text, needle) > baselineOccurrences)
          .map(({ needle }) => promptGuard(screen.text, needle))
          .find(Boolean) ?? "";
    if (expectedPrompt) {
      if (opts.isActive && !opts.isActive()) return "stalled";
      await opts.sendEnter({ expectedPrompt, expectedSignature: screen.hash });
      return "sent";
    }
    if (attempt + 1 >= maxReads || Date.now() >= deadline) return "stalled";
    await wait(nextPollDelay(startedAt, deadline));
  }
  return "stalled";
}
