import { describe, expect, test } from "bun:test";
import { AgentTraceRPC } from "./agent-trace";
import { ProtocolError } from "./errors";

const legacyPage = {
  items: [{ type: "tool", name: "Read", input: '{"path":"secret"}', output: "private" }],
  next_cursor: null,
  truncated: false,
};

describe("AgentTrace rolling RPC", () => {
  test("falls back once for an old daemon and remembers that decision", async () => {
    const calls: string[] = [];
    const reader = new AgentTraceRPC(async (op) => {
      calls.push(op);
      if (op === "AgentTraceSummary") throw new ProtocolError("unknown_op", op);
      return legacyPage;
    });
    expect((await reader.read("p1")).items[0].input).toContain("secret");
    await reader.read("p1");
    expect(calls).toEqual(["AgentTraceSummary", "AgentTrace", "AgentTrace"]);
  });

  test("does not downgrade on a real summary failure", async () => {
    const calls: string[] = [];
    const reader = new AgentTraceRPC(async (op) => {
      calls.push(op);
      throw new ProtocolError("transcript_unavailable", "missing");
    });
    await expect(reader.read("p1")).rejects.toMatchObject({ code: "transcript_unavailable" });
    expect(calls).toEqual(["AgentTraceSummary"]);
  });

  test("parses summary and separately bound detail shapes", async () => {
    const calls: string[] = [];
    const reader = new AgentTraceRPC(async (op, params) => {
      calls.push(op);
      if (op === "AgentTraceSummary") {
        return { items: [{ type: "tool", name: "Read", state: "done", detail_ref: "d1" }], next_cursor: null, truncated: false };
      }
      return { detail_ref: params.detail_ref, input: "secret", output: "private", truncated: false };
    });
    expect((await reader.read("p1")).items[0]).toEqual({ type: "tool", name: "Read", toolState: "done", detailRef: "d1" });
    expect(await reader.detail("p1", "d1")).toEqual({ detailRef: "d1", input: "secret", output: "private", truncated: false });
    expect(calls).toEqual(["AgentTraceSummary", "AgentTraceDetail"]);
  });
});
