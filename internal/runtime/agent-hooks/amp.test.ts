import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: string[][] = [];
mock.module("node:child_process", () => ({
  execFile(binary: string, args: string[], options: { timeout: number }, done: () => void) {
    expect(binary).toBe("/safe/pairfob");
    expect(options.timeout).toBeLessThan(4000);
    calls.push(args);
    done();
  },
}));
const before = { ...process.env };
const directory = mkdtempSync(join(tmpdir(), "pairfob-amp-hook-"));
afterAll(() => { process.env = before; mock.restore(); rmSync(directory, { recursive: true, force: true }); });
const source = (await Bun.file(new URL("./amp.js", import.meta.url)).text())
  .replace("PAIRFOB_BINARY", JSON.stringify("/safe/pairfob"));
const modulePath = join(directory, "amp.mjs");
writeFileSync(modulePath, source);
const { default: plugin } = await import(modulePath);
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test("Amp observes the active thread, ignores background runs, and clears on deselection", async () => {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = "/private/herdr.sock";
  let observe: (value: { id: string } | null) => void = () => {};
  let dispose = () => {};
  let unsubscribed = false;
  const events: Record<string, Function> = {};
  const api = {
    system: { executor: { kind: "local" } },
    activeThread: {
      current: { id: "T-first-session" } as { id: string } | null,
      subscribe(fn: typeof observe) { observe = fn; return { unsubscribe() { unsubscribed = true; } }; },
    },
    on(name: string, fn: Function) { events[name] = fn; },
    onDispose(fn: typeof dispose) { dispose = fn; },
  };
  plugin(api);
  events["agent.start"]({ thread: { id: "T-background-child" } });
  api.activeThread.current = { id: "T-second-session" };
  observe(api.activeThread.current);
  events["agent.start"]({ thread: { id: "T-second-session" } });
  api.activeThread.current = null;
  observe(null);
  await flush();
  expect(calls.map(args => [args[2], args[4]])).toEqual([
    ["T-first-session", "bind"], ["T-second-session", "bind"],
    ["T-second-session", "bind"], ["T-second-session", "clear"],
  ]);
  const sequences = calls.map(args => Number(args[3]));
  expect(sequences.every((value, i) => i === 0 || value > sequences[i - 1])).toBe(true);
  dispose(); expect(unsubscribed).toBe(true);
  calls.length = 0;
  api.system.executor.kind = "remote";
  plugin(api); await flush(); expect(calls).toHaveLength(0);
  process.env.HERDR_ENV = "";
  api.system.executor.kind = "local";
  plugin(api); await flush(); expect(calls).toHaveLength(0);
});
