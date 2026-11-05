/**
 * Waiting for a condition instead of for a duration.
 *
 * A test that sleeps a fixed number of milliseconds and then asserts is racing
 * the machine: the work it waits on finishes in that window alone, and misses
 * it when a suite of eight workers is sharing the CPU. The assertion the test
 * actually means is "this became true", so it polls for that, with a deadline
 * long enough to be a failure and not a flake.
 */
export async function waitFor(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    // A macrotask turn: timers and promise chains the work is waiting on run
    // between polls, and the loop itself costs nothing while it waits.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
