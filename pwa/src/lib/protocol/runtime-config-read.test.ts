import { beforeEach, expect, test } from "bun:test";
import { readRuntimeConfig, resetRuntimeConfigReads, terminalUsesRawStream } from "./runtime-config-read";
import type { LiveSession } from "./session-types";

beforeEach(resetRuntimeConfigReads);
function fixture() {
  let calls = 0;
  let scope: string | null = null;
  let resolve!: (config: Record<string, unknown>) => void;
  const session = { herdSession: () => scope, getConfig: () => {
    calls++;
    return new Promise<Record<string, unknown>>(done => { resolve = done; });
  } } as unknown as LiveSession;
  return { session, calls: () => calls, select: (value: string) => { scope = value; }, resolve: (config: Record<string, unknown>) => resolve(config) };
}
for (const observerFirst of [true, false]) {
  test("observer/open share pending GetConfig, observer first=" + observerFirst, async () => {
    const f = fixture();
    const first = readRuntimeConfig(f.session, observerFirst);
    const second = readRuntimeConfig(f.session, !observerFirst);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(f.calls()).toBe(1);
    f.resolve({ capabilities: { terminal_client_scroll: true } });
    expect(terminalUsesRawStream(await first)).toBeTrue();
    expect(readRuntimeConfig(f.session)).toBe(first);
    const refresh = readRuntimeConfig(f.session, true);
    expect(refresh).not.toBe(first);
    await Promise.resolve();
    expect(f.calls()).toBe(2);
    f.resolve({});
    expect(terminalUsesRawStream(await refresh)).toBeFalse();
  });
}
for (const retire of ["disconnect", "scope"]) {
  test(retire + " rejects a late configuration", async () => {
    const f = fixture();
    const read = readRuntimeConfig(f.session);
    await Promise.resolve();
    if (retire === "disconnect") resetRuntimeConfigReads(); else f.select("another");
    f.resolve({ capabilities: { terminal_client_scroll: true } });
    await expect(read).rejects.toThrow("retired view");
    expect(readRuntimeConfig(f.session)).not.toBe(read);
    await Promise.resolve();
    f.resolve({});
    await readRuntimeConfig(f.session);
  });
}
test("only a boolean grant selects raw mode; old daemons use snapshots", () => {
  expect(terminalUsesRawStream({})).toBeFalse();
  expect(terminalUsesRawStream({ capabilities: {} })).toBeFalse();
  expect(terminalUsesRawStream({ capabilities: { terminal_client_scroll: false } })).toBeFalse();
  expect(() => terminalUsesRawStream({ capabilities: { terminal_client_scroll: "true" } })).toThrow();
});
