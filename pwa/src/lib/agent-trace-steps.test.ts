import { beforeEach, describe, expect, test } from "bun:test";
import { setLang, t } from "./i18n.ts";
import type { AgentTraceItem } from "./operations";
import { formatElapsed, pendingAsk, stepCategory, stepObject, stepState, turnOutcome, turnSpan } from "./agent-trace-steps";

beforeEach(() => setLang("zh"));

const tool = (name: string, extra: Partial<AgentTraceItem> = {}): AgentTraceItem => ({ type: "tool", name, ...extra });
const done = { live: false, waiting: false, stale: false, verified: true };

describe("step categories follow each agent's own tool names", () => {
  test("Claude Code, Codex, Grok and Pi names map to the same kinds", () => {
    const cases: Array<[string, string]> = [
      ["Read", "read"], ["read", "read"], ["read_file", "read"], ["list_dir", "read"],
      ["Grep", "search"], ["Glob", "search"], ["grep", "search"],
      ["Edit", "edit"], ["Write", "edit"], ["edit", "edit"], ["apply_patch", "edit"],
      ["Bash", "command"], ["bash", "command"], ["exec_command", "command"], ["run_terminal_command", "command"], ["write_stdin", "command"],
      ["WebFetch", "web"], ["Agent", "subtask"], ["Task", "subtask"],
      ["TodoWrite", "plan"], ["update_plan", "plan"],
      ["AskUserQuestion", "question"], ["request_user_input_async", "question"],
      ["mcp__github__create_issue", "mcp"], ["SomethingNew", "other"],
    ];
    for (const [name, category] of cases) expect([name, stepCategory(tool(name))]).toEqual([name, category]);
    expect(stepCategory({ type: "thinking", text: "x" })).toBe("think");
  });

  test("objects shorten paths, keep commands and name MCP servers", () => {
    expect(stepObject(tool("Read", { label: "/Users/me/repo/pwa/src/app/bootstrap.ts" }))).toBe("app/bootstrap.ts");
    expect(stepObject(tool("apply_patch", { label: "internal/journal/trace.go +2" }))).toBe("journal/trace.go +2");
    expect(stepObject(tool("Bash", { label: "bun test src/app" }))).toBe("bun test src/app");
    expect(stepObject(tool("mcp__github__create_issue", { label: "Fix boot" }))).toBe("github · create_issue · Fix boot");
    expect(stepObject(tool("Read", { input: '{"path":"a.ts"}' }))).toBe("Read a.ts");
    expect(stepObject(tool("Read"))).toBe("Read");
    expect(stepObject({ type: "thinking", text: "\n  first line\nsecond" })).toBe("first line");
  });

  test("Codex reading a running command says so instead of naming write_stdin", () => {
    const output = t("work.commandOutput");
    // A direct call carries no label; code mode labels the snippet by its first tool.
    expect(stepObject(tool("write_stdin"))).toBe(output);
    expect(stepObject(tool("write_stdin", { input: '{"session_id":7,"chars":""}' }))).toBe(output);
    expect(stepObject(tool("exec", { label: "write_stdin" }))).toBe(output);
    expect(stepObject(tool("exec", { label: "write_stdin +1" }))).toBe(`${output} +1`);
    // A command that merely mentions it stays a command.
    expect(stepObject(tool("exec", { label: "rg write_stdin src" }))).toBe("rg write_stdin src");
  });

  test("an unverified daemon never turns done into success", () => {
    expect(stepState(tool("Read", { toolState: "done" }), false)).toBe("ended");
    expect(stepState(tool("Read", { toolState: "done" }), true)).toBe("done");
    expect(stepState(tool("Read", { toolState: "error" }), false)).toBe("error");
  });
});

describe("turn outcome leads with what the reader needs", () => {
  test("a failed step the agent worked past is routine: the card still leads with changes or the step count", () => {
    const fail = tool("Bash", { label: "bun test", toolState: "error" });
    const read = tool("Read", { toolState: "done" });
    const reply: AgentTraceItem = { type: "assistant", text: "Done." };
    expect(turnOutcome([fail, read], done)).toMatchObject({ tone: "done", title: t("work.doneSteps", { n: 2 }) });
    expect(turnOutcome([read, fail, reply], done)).toMatchObject({ tone: "done", title: t("work.doneSteps", { n: 2 }) });
    expect(turnOutcome([tool("Edit", { label: "src/a.ts", toolState: "done" }), fail, reply], done))
      .toMatchObject({ tone: "done", title: t("work.changedFiles", { n: 1 }) });
  });

  test("only a turn that stopped on a failed step says so", () => {
    const fail = tool("Bash", { label: "bun test", toolState: "error" });
    const read = tool("Read", { toolState: "done" });
    const thought: AgentTraceItem = { type: "thinking", text: "Try again?" };
    expect(turnOutcome([read, fail], done)).toMatchObject({ tone: "error", title: t("work.endedFailed"), detail: `bun test · ${t("work.total", { n: 2 })}` });
    expect(turnOutcome([read, fail, thought], done).tone).toBe("error");
    // A message sent mid-run moves the work to the next turn: this one did not stop there.
    expect(turnOutcome([read, fail], { ...done, hasNext: true })).toMatchObject({ tone: "done", title: t("work.doneSteps", { n: 2 }) });
  });

  test("changed files outrank a step count", () => {
    const edit = tool("Edit", { label: "src/a.ts", toolState: "done" });
    expect(turnOutcome([edit, tool("Edit", { label: "src/a.ts", toolState: "done" })], done))
      .toMatchObject({ tone: "done", title: t("work.changedFiles", { n: 1 }), detail: `a.ts · ${t("work.total", { n: 2 })}` });
    expect(turnOutcome([tool("Read", { toolState: "done" })], done)).toMatchObject({ title: t("work.doneSteps", { n: 1 }) });
    expect(turnOutcome([tool("Read", { toolState: "done" })], { ...done, verified: false }).tone).toBe("neutral");
  });

  test("live, waiting, lost connection and interrupt each say so", () => {
    const running = [tool("Read", { toolState: "done" }), tool("Bash", { toolState: "running" }), tool("Grep", { toolState: "running" })];
    expect(turnOutcome(running, { ...done, live: true }).title).toBe(t("work.runningMany", { n: 2 }));
    expect(turnOutcome([], { ...done, live: true }).title).toBe(t("work.starting"));
    expect(turnOutcome(running, { ...done, live: true, waiting: true }).tone).toBe("waiting");
    expect(turnOutcome(running, { ...done, live: true, stale: true }).tone).toBe("stale");
    expect(turnOutcome([{ type: "interrupt" }], done)).toMatchObject({ tone: "interrupted", detail: t("work.notStarted") });
  });

  test("the latest plan reads as progress", () => {
    const plan = [tool("TodoWrite", { label: "1/4" }), tool("Read"), tool("TodoWrite", { label: "3/4" })];
    expect(turnOutcome(plan, done).detail).toBe(t("work.plan", { progress: "3/4" }));
  });
});

test("a blocked agent's ask is its last running tool", () => {
  expect(pendingAsk([tool("Read", { toolState: "done" }), tool("Bash", { label: "rm -rf dist", toolState: "running" })]))
    .toEqual({ verb: t("needs.run"), object: "rm -rf dist" });
  expect(pendingAsk([tool("AskUserQuestion", { label: "Which computer?", toolState: "running" })]))
    .toEqual({ verb: t("needs.ask"), object: "Which computer?" });
  expect(pendingAsk([tool("Read", { toolState: "done" })])).toBeNull();
});

test("a turn's span and elapsed text come from its own record times", () => {
  expect(turnSpan({ type: "user", text: "go", at: 1_000 }, [tool("Read", { at: 2_000 }), { type: "assistant", text: "ok", at: 186_000 }]))
    .toEqual({ start: 1_000, end: 186_000 });
  expect(turnSpan({ type: "user", text: "pending", pending: true }, [tool("Read", { at: 5_000 })])).toEqual({ start: 5_000, end: 5_000 });
  expect(turnSpan(undefined, [tool("Read")])).toEqual({ start: undefined, end: undefined });
  expect(formatElapsed(42_400)).toBe(t("time.seconds", { s: 42 }));
  expect(formatElapsed(185_000)).toBe(t("time.minutes", { m: 3, s: 5 }));
  expect(formatElapsed(3_900_000)).toBe(t("time.hours", { h: 1, m: 5 }));
});
