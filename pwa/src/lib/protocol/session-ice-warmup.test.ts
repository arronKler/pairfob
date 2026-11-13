import { expect, test } from "bun:test";

// Isolate module stand-ins from other protocol/session tests.
test("ICE preparation follows the real reconnecting session's authentication lifecycle", async () => {
  const target = new URL("../../../test-support/session-ice-warmup-isolated.test.ts", import.meta.url);
  const child = Bun.spawn(["bun", "test", target.pathname], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stderr).toContain("3 pass");
}, 15_000);
