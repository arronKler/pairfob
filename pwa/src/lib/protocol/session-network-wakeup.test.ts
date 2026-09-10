import { expect, test } from "bun:test";

// Pairing tests mock the client re-export; isolate real session transport tests.
test("network wakeups retain one fresh dial through real encrypted transports", async () => {
  const target = new URL("../../../test-support/session-network-wakeup-isolated.test.ts", import.meta.url);
  const process = Bun.spawn(["bun", "test", target.pathname], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stderr).toContain("8 pass");
}, 15_000);
