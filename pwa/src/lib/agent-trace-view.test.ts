import { describe, expect, test } from "bun:test";
import {
  firstTurnNeedsUser,
  groupAgentTurns,
  groupAgentTurnBlocks,
  mergeAgentTraceSegments,
  processTitle,
  replyText,
  stepSummary,
  stepKey,
  toolState,
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
    expect(turns[0].items.map((item) => item.type)).toEqual(["thinking", "tool", "assistant"]);
  });

  test("a later user message starts a new turn", () => {
    const turns = groupAgentTurns([
      { type: "user", text: "one" },
      { type: "assistant", text: "first" },
      { type: "user", text: "two" },
      { type: "thinking", text: "next" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].items[0]?.text).toBe("first");
    expect(turns[1].items).toHaveLength(1);
  });

  test("keeps an assistant preamble before a tool and the final reply after it", () => {
    const turn = groupAgentTurns([
      { type: "user", text: "inspect this" },
      { type: "assistant", text: "I will check first." },
      { type: "tool", name: "Read", input: '{"path":"a.ts"}', output: "ok" },
      { type: "assistant", text: "Everything is fine." },
    ])[0];
    const blocks = groupAgentTurnBlocks(turn.items);
    expect(blocks.map((block) => block.type)).toEqual(["reply", "process", "reply"]);
    expect(blocks.flatMap((block) => block.items).map((item) => item.type)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
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
    expect(stepSummary({ type: "tool", name: "Read", input: '{"path":"a.ts"}' })).toBe("Read a.ts");
    expect(stepSummary({ type: "thinking", text: "secret chain" })).toBe("思考");
  });

  test("reports only explicit tool states and keeps identity stable across output updates", () => {
    const pending = { type: "tool" as const, name: "Read", input: '{"path":"a.ts"}' };
    expect(toolState(pending)).toBe("running");
    expect(toolState({ ...pending, output: "ok" })).toBe("done");
    expect(toolState({ ...pending, output: "失败" })).toBe("error");
    expect(stepKey(pending, 2)).toBe(stepKey({ ...pending, output: "ok" }, 2));
  });
});

describe("replyText", () => {
  test("keeps complete adjacent messages as separate paragraphs", () => {
    expect(replyText([
      { type: "assistant", text: "First." },
      { type: "assistant", text: "Second." },
    ])).toBe("First.\n\nSecond.");
  });
});

describe("mergeAgentTraceSegments", () => {
  test("deduplicates the owning user repeated across a page seam", () => {
    const merged = mergeAgentTraceSegments(
      [{ type: "user", text: "inspect" }, { type: "tool", name: "Read", output: "first" }],
      [{ type: "user", text: "inspect" }, { type: "tool", name: "Read", output: "last" }],
    );
    expect(merged.overlap).toBe(1);
    expect(merged.items.map((item) => item.type)).toEqual(["user", "tool", "tool"]);
  });

  test("does not merge different user turns", () => {
    const merged = mergeAgentTraceSegments(
      [{ type: "user", text: "first" }, { type: "assistant", text: "done" }],
      [{ type: "user", text: "second" }, { type: "assistant", text: "done" }],
    );
    expect(merged.overlap).toBe(0);
    expect(merged.items.filter((item) => item.type === "user")).toHaveLength(2);
  });

  test("keeps repeated prompts when the earlier turn has a completed reply", () => {
    const merged = mergeAgentTraceSegments(
      [{ type: "user", text: "continue" }, { type: "assistant", text: "first done" }],
      [{ type: "user", text: "continue" }, { type: "assistant", text: "second done" }],
    );
    expect(merged.overlap).toBe(0);
    expect(merged.items.filter((item) => item.type === "user")).toHaveLength(2);
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
      items: [
        { type: "tool" as const, name: "Read", input: '{"path":"a.ts"}', output: "ok" },
        { type: "assistant" as const, text: "done" },
      ],
    };
    expect(turnKey(turn)).toContain("inspect this");
    expect(turnKey(turn)).toContain("Read");
  });
});
