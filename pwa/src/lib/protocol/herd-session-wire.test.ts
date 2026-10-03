import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HERD_SESSION_SCOPED_OPS, scopeHerdSession } from "./herd-sessions.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Every op whose request clause in proto/rpc.schema.json declares a `session` param. */
function schemaSessionOps(): string[] {
  const schema = JSON.parse(readFileSync(resolve(here, "../../../../proto/rpc.schema.json"), "utf8"));
  const ops = new Set<string>();
  for (const clause of schema.$defs.request.allOf as { if?: { properties?: { op?: { const?: string; enum?: string[] } } }; then?: unknown }[]) {
    const op = clause.if?.properties?.op;
    if (!op || !JSON.stringify(clause.then ?? {}).includes('"session"')) continue;
    for (const name of op.const ? [op.const] : op.enum ?? []) ops.add(name);
  }
  return [...ops].sort();
}

describe("Herdr session scoping", () => {
  test("scopes exactly the ops the schema lets carry a session", () => {
    // A strict daemon decoder rejects an unknown `session` field, and an op
    // missing here would silently hit the default session: both directions fail.
    expect([...HERD_SESSION_SCOPED_OPS].sort()).toEqual(schemaSessionOps());
  });

  test("the default session leaves params untouched", () => {
    const params = { pane_id: "w1:p1" };
    expect(scopeHerdSession("PaneRead", params, null)).toBe(params);
    expect(scopeHerdSession("ListDevices", {}, "work")).toEqual({});
    expect(scopeHerdSession("PaneRead", params, "work")).toEqual({ pane_id: "w1:p1", session: "work" });
  });
});

// The real-session wire checks stub process-global I/O with mock.module, so
// they run in a child process like the upload-v2 and media ownership suites.
describe("Herdr session wire (isolated child process)", () => {
  test("default wire unchanged, selected session scoped, issue-time capture, strict list parse", async () => {
    const pwaRoot = resolve(here, "../../..");
    const proc = Bun.spawn(["bun", "test", resolve(pwaRoot, "test-support", "herd-session-wire-isolated.test.ts"), "--timeout", "20000"], {
      cwd: pwaRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`isolated herd session wire test exited ${exit}\n${stdout}\n${stderr}`);
    expect(stderr).toContain("6 pass");
    expect(stderr).toContain("0 fail");
  }, 25_000);
});
