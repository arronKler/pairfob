import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The four settings-lifecycle cases run in an isolated real `bun test` child
 * process (test-support/settings-lifecycle-isolated.test.ts, never collected by
 * `bun test src`). The release-check cases run real checkDaemonRelease /
 * refreshDaemonUpdate calls that mutate the shared daemon-update model (private
 * per-daemon views plus global latest/next-check state), which has no restore
 * API; executing them only inside this spawned child keeps every such mutation
 * out of this worker and its sibling settings suites.
 *
 * This thin entry follows the repo's existing isolated-runner pattern
 * (workspace-media-ownership.test.ts): it spawns the child with the same bun
 * runtime (process.execPath), reads BOTH pipes (no deadlock), waits on the real
 * exit code, and forwards the child's full stdout/stderr even on success (so any
 * act warnings inside the child stay visible). The child's per-test --timeout
 * bounds each case, but it does NOT guarantee the whole process exits (module
 * load or an endless process can outrun it), so a single whole-child watchdog
 * below SIGKILLs the owned child after 50s — the parent test times out at 60s,
 * so the watchdog always fires first. A watchdog hit fails even if the exit code
 * were 0, and the child (which spawns nothing else) is always killed and reaped
 * in finally.
 */
describe("settings lifecycle (isolated child process)", () => {
  test(
    "all four original cases keep their inputs, awaits, and assertions",
    async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const pwaRoot = resolve(here, "../../..");
      const target = resolve(pwaRoot, "test-support", "settings-lifecycle-isolated.test.ts");
      const proc = Bun.spawn([process.execPath, "test", target, "--timeout", "20000"], {
        cwd: pwaRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let exit: number | undefined;
      let stdout = "";
      let stderr = "";
      try {
        watchdog = setTimeout(() => {
          timedOut = true;
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        }, 50_000);
        const reads = await Promise.all([
          new Response(proc.stdout).text().catch((e) => `[stdout read failed] ${e}`),
          new Response(proc.stderr).text().catch((e) => `[stderr read failed] ${e}`),
        ]);
        stdout = reads[0];
        stderr = reads[1];
        exit = await proc.exited;
        // Forward the child's full output BEFORE any outcome throw, so even a
        // 50s watchdog hit keeps the child's final stdout/stderr visible.
        console.log(`[settings-lifecycle child stdout]\n${stdout}`);
        console.log(`[settings-lifecycle child stderr]\n${stderr}`);
        if (timedOut) {
          throw new Error(`isolated settings lifecycle child exceeded 50s and was killed (exit ${exit})`);
        }
        if (exit !== 0) {
          throw new Error(`isolated settings lifecycle test exited ${exit}\n${stdout}\n${stderr}`);
        }
        const combined = `${stdout}\n${stderr}`;
        // Explicit per-case outcomes (the original four titles) and the bun
        // summary — extra evidence on top of the real exit code.
        for (const title of [
          "persistent manual copy label follows language repaint",
          "compact later hides even if browser storage is unavailable",
          "persistent settings notice updates and clears through real subscription",
          "daemon release check updates the mounted subtree without repainting the app",
        ]) {
          expect(combined).toContain(`(pass) ${title}`);
        }
        expect(stderr).toContain("4 pass");
        expect(stderr).toContain("0 fail");
        expect(stderr).toContain("18 expect() calls");
      } finally {
        clearTimeout(watchdog);
        // Hard-kill + reap the owned child if it is still running (watchdog hit
        // or a read/check aborted early). The child spawns nothing else.
        try {
          if (proc.kill(0)) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }
        } catch { /* signal 0 unsupported; the watchdog already bounds the child */ }
        await proc.exited.catch(() => undefined);
      }
    },
    60_000,
  );
});