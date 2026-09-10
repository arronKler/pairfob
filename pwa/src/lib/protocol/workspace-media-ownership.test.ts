import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The late-Open / P2P-barrier ownership test stubs network and negotiation I/O
// with bun mock.module, which is process-global. It must run in a child process so
// the stubbed openWS cannot serve other protocol tests in the same suite process.
describe("workspace media late-Open ownership (isolated child process)", () => {
  test(
    "real sessionOverWS -> DirectSessionDriver -> TransportCommit barrier never closes on the replacement epoch",
    async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const pwaRoot = resolve(here, "../../..");
      const target = resolve(pwaRoot, "test-support", "media-ownership-isolated.test.ts");
      const proc = Bun.spawn(["bun", "test", target, "--timeout", "20000"], {
        cwd: pwaRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exit = await proc.exited;
      if (exit !== 0) {
        throw new Error(`isolated media ownership test exited ${exit}\n${stdout}\n${stderr}`);
      }
      // Bun writes the run summary to stderr.
      expect(stderr).toContain("2 pass");
      expect(stderr).toContain("0 fail");
    },
    25_000,
  );
});
