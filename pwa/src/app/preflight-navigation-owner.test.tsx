import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The complete preflight navigation-owner fixture stubs the shared-ESM
 * full-terminal loader with bun `mock.module` (process-global, not undoable by
 * `mock.restore`). It can never share a worker with any real-loader control, so
 * the full fixture lives in test-support/ — never collected by `bun test src` —
 * and is executed ONLY here, in an explicitly spawned isolated `bun test`
 * process whose real exit code and summary this thin entry verifies. The
 * watchdog below really kills and reaps the child on budget, not just on the
 * case-level timeout.
 */
describe("preflight navigation owner (isolated child process)", () => {
  test(
    "all six creation/close ownership cases keep real-App live-stage behavior",
    async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const pwaRoot = resolve(here, "../..");
      const target = resolve(pwaRoot, "test-support", "preflight-navigation-owner-isolated.test.ts");
      const proc = Bun.spawn(["bun", "test", target, "--timeout", "30000"], {
        cwd: pwaRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const { stdout, stderr, exit } = await runBounded(proc, 60_000);
      if (exit !== 0) {
        throw new Error(`isolated preflight navigation owner test exited ${exit}\n${stdout}\n${stderr}`);
      }
      // Bun writes the run summary to stderr.
      expect(stderr).toContain("6 pass");
      expect(stderr).toContain("0 fail");
    },
    90_000,
  );
});

/**
 * Collect a child's output, wait for its REAL exit, and kill+reap if it exceeds the
 * budget. A budget hit can never be reported as success: the timeout state is set
 * synchronously BEFORE any await/kill, both watchdog timers are tracked and cleared,
 * and the child is always awaited (reaped) after the SIGTERM/SIGKILL escalation.
 */
async function runBounded(child: ReturnType<typeof Bun.spawn>, budgetMs: number): Promise<{ stdout: string; stderr: string; exit: number }> {
  const stdoutText = new Response(child.stdout).text();
  const stderrText = new Response(child.stderr).text();
  const exited = child.exited;
  let timedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  // Never resolves first: it only rejects after the child has been killed and reaped,
  // so the race below always surfaces the true exit code while the timedOut flag is the
  // authority for whether the budget was hit.
  const deadline = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => {
      timedOut = true;                     // set BEFORE awaiting anything
      child.kill();                        // SIGTERM
      escalation = setTimeout(() => {      // tracked: cleared in finally before any late SIGKILL
        child.kill("SIGKILL");
      }, 1000);
      void exited
        .catch(() => undefined)            // reap the killed child, never a zombie
        .then(() => reject(new Error(`isolated child exceeded ${budgetMs}ms budget; killed and reaped`)), reject);
    }, budgetMs);
  });
  let exit: number;
  try {
    exit = await Promise.race([exited, deadline]);
  } finally {
    clearTimeout(watchdog);
    clearTimeout(escalation);
  }
  if (timedOut) {
    throw new Error(`isolated child exceeded ${budgetMs}ms budget (exit ${exit}); killed and reaped`);
  }
  const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
  return { stdout, stderr, exit };
}