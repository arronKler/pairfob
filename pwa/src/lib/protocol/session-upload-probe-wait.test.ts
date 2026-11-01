// Process-isolation wrapper: the real probe-wait regression suite uses
// process-global mock.module stubs, so it runs in a child bun process (same
// pattern as session-upload-v2.test.ts). The child lives in the repository
// isolation location pwa/test-support/ (root test-support is not collected by
// `bun test src`).
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("upload probe-wait gate integration (isolated child process)", () => {
  test("same-epoch probe pauses then dispatches once; retirement/switch/close/timeout reject unsent; controls still block", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pwaRoot = resolve(here, "../../..");
    const target = resolve(pwaRoot, "test-support", "session-upload-probe-wait-isolated.test.ts");
    const proc = Bun.spawn(["bun", "test", target, "--timeout", "20000"], {
      cwd: pwaRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      throw new Error(`isolated probe-wait test exited ${exit}\n${stdout}\n${stderr}`);
    }
    expect(stderr).toContain("11 pass");
    expect(stderr).toContain("0 fail");
  }, 30_000);
});
