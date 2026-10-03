import { describe, expect, test } from "bun:test";
import { AgentTraceRPC } from "./agent-trace";
import { ProtocolError } from "./errors";
import { daemonNow, noteDaemonClock } from "../agent-trace-clock";

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

  test("asks for markers only while the daemon advertises trace_markers", async () => {
    const sent: Record<string, unknown>[] = [];
    let advertised = false;
    const reader = new AgentTraceRPC(async (_op, params) => {
      sent.push(params);
      return { items: [], next_cursor: null, truncated: false };
    }, () => advertised);
    await reader.read("p1");
    advertised = true;
    await reader.read("p1");
    expect(sent.map((params) => "markers" in params)).toEqual([false, true]);
    expect(sent[1].markers).toBe(true);
  });

  test("asks for labels only on the summary read and only while advertised", async () => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    let labels = false;
    const reader = new AgentTraceRPC(async (op, params) => {
      sent.push([op, params]);
      if (op === "AgentTraceSummary" && sent.length === 3) throw new ProtocolError("unknown_op", op);
      return { items: [], next_cursor: null, truncated: false };
    }, () => true, () => labels);
    await reader.read("p1");
    labels = true;
    await reader.read("p1");
    await reader.read("p1");
    expect(sent.map(([op, params]) => [op, "labels" in params])).toEqual([
      ["AgentTraceSummary", false], ["AgentTraceSummary", true], ["AgentTraceSummary", true], ["AgentTrace", false],
    ]);
  });

  test("asks for record times on the summary read only while advertised", async () => {
    const sent: Record<string, unknown>[] = [];
    let times = false;
    const reader = new AgentTraceRPC(async (_op, params) => { sent.push(params); return { items: [], next_cursor: null, truncated: false }; },
      () => false, () => false, () => times);
    await reader.read("p1");
    times = true;
    await reader.read("p1");
    expect(sent.map((params) => params.times)).toEqual([undefined, true]);
  });

  test("a timed reply records the computer's clock for elapsed time", async () => {
    const reader = new AgentTraceRPC(async () => ({ items: [], next_cursor: null, truncated: false, now: Date.now() + 120_000 }),
      () => false, () => false, () => true);
    await reader.read("p1");
    expect(Math.round((daemonNow() - Date.now()) / 1000)).toBe(120);
    noteDaemonClock(Date.now());
  });
});
