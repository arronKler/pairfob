import { describe, expect, test } from "bun:test";
import {
  firstTurnNeedsUser,
  groupAgentTurns,
  processTitle,
  stepSummary,
  toolSummary,
  turnKey,
} from "./agent-trace-view";

describe("groupAgentTurns", () => {
  test("one user turn owns following thinking, tools, and the reply", () => {
    const turns = groupAgentTurns([
      { type: "user", text: "inspect this" },
      { type: "thinking", text: "I will read it" },
      { type: "tool", name: "Read", input: '{"path":"a.ts"}', output: "ok" },
      { type: "assistant", text: "looks **fine**" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].user?.text).toBe("inspect this");
    expect(turns[0].steps.map((step) => step.type)).toEqual(["thinking", "tool"]);
    expect(turns[0].replies).toHaveLength(1);
  });

  test("a later user message starts a new turn", () => {
    const turns = groupAgentTurns([
      { type: "user", text: "one" },
      { type: "assistant", text: "first" },
      { type: "user", text: "two" },
      { type: "thinking", text: "next" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].replies[0]?.text).toBe("first");
    expect(turns[1].steps).toHaveLength(1);
    expect(turns[1].replies).toHaveLength(0);
  });

  test("a tail that starts mid-run still needs its user page", () => {
    const tail = [
      { type: "tool" as const, name: "Read", input: '{"path":"a.ts"}', output: "ok" },
      { type: "assistant" as const, text: "done" },
    ];
    expect(firstTurnNeedsUser(tail, "cursor")).toBe(true);
    expect(firstTurnNeedsUser([{ type: "user", text: "inspect this" }, ...tail], "cursor")).toBe(false);
    expect(firstTurnNeedsUser(tail, null)).toBe(false);
  });
});

describe("toolSummary", () => {
  test("reads a path or a command instead of dumping JSON", () => {
    expect(toolSummary({ type: "tool", name: "Read", input: '{"path":"src/lib/a.ts"}' })).toBe("Read src/lib/a.ts");
    expect(toolSummary({ type: "tool", name: "shell", input: '{"command":"git status"}' })).toBe("git status");
  });

  test("pending tools stay one line", () => {
    expect(stepSummary({ type: "tool", name: "Read", input: '{"path":"a.ts"}' })).toBe("Read a.ts · 执行中");
    expect(stepSummary({ type: "thinking", text: "secret chain" })).toBe("思考");
  });
});

describe("processTitle", () => {
  test("live turns say 正在执行; finished turns stay compact", () => {
    const steps = [
      { type: "thinking" as const, text: "plan" },
      { type: "tool" as const, name: "Read", input: '{"path":"a.ts"}', output: "ok" },
    ];
    expect(processTitle(steps, true)).toBe("正在执行");
    expect(processTitle(steps, false)).toBe("执行过程 · 思考与 1 个工具");
  });
});

describe("turnKey", () => {
  test("identity comes from the user text, not a sliding index", () => {
    const turn = {
      user: { type: "user" as const, text: "inspect this" },
      steps: [{ type: "tool" as const, name: "Read", input: '{"path":"a.ts"}', output: "ok" }],
      replies: [{ type: "assistant" as const, text: "done" }],
    };
    expect(turnKey(turn)).toContain("inspect this");
    expect(turnKey(turn)).toContain("Read");
  });
});
