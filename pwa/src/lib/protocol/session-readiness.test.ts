import { expect, test } from "bun:test";

// Keep transport-I/O mocks out of the shared protocol suite.
test("session readiness and mutation delivery through real encrypted transports", async () => {
  const target = new URL("../../../test-support/session-readiness-isolated.test.ts", import.meta.url);
  const process = Bun.spawn(["bun", "test", target.pathname], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stderr).toContain("7 pass");
}, 15_000);
