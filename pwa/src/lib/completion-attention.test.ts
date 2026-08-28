import { describe, expect, test } from "bun:test";
import type { DashboardAgentCard } from "./dashboard";
import {
  markCompletionSeen,
  parseSeenCompletions,
  projectAgentSubmission,
  projectCompletionAttention,
} from "./completion-attention";

function agent(paneId: string, status: DashboardAgentCard["status"]): DashboardAgentCard {
  return { paneId, status, agent: "codex", hasAgent: true, workspaceLabel: "Pairfob", cwd: "/repo" };
}

describe("completion attention", () => {
  test("a viewed completion is presented as idle across snapshots", () => {
    const first = projectCompletionAttention([agent("p1", "done")], {}, { p1: true });
    expect(first.runtimeStatuses.p1).toBe("done");
    expect(first.agents[0].status).toBe("idle");

    const next = projectCompletionAttention([agent("p1", "done")], first.runtimeStatuses, first.seen);
    expect(next.agents[0].status).toBe("idle");
    expect(next.seen).toBe(first.seen);
  });

  test("a new completion becomes visible after intervening work", () => {
    const working = projectCompletionAttention([agent("p1", "working")], { p1: "done" }, { p1: true });
    expect(working.seen).toEqual({});
    expect(working.agents[0].status).toBe("working");

    const completed = projectCompletionAttention([agent("p1", "done")], working.runtimeStatuses, working.seen);
    expect(completed.agents[0].status).toBe("done");
  });

  test("reading only acknowledges a currently completed pane", () => {
    const seen = markCompletionSeen({}, { p1: "done", p2: "working" }, "p1");
    expect(seen).toEqual({ p1: true });
    expect(markCompletionSeen(seen, { p1: "done", p2: "working" }, "p2")).toBe(seen);
  });

  test("a successful submit starts a new cycle before the next terminal read", () => {
    const submitted = projectAgentSubmission(
      [agent("p1", "idle"), agent("p2", "idle")],
      { p1: "done", p2: "done" },
      { p1: true, p2: true },
      "p1",
    );
    expect(submitted.agents[0].status).toBe("working");
    expect(submitted.runtimeStatuses.p1).toBe("working");
    expect(submitted.seen).toEqual({ p2: true });

    const completed = projectCompletionAttention([agent("p1", "done")], submitted.runtimeStatuses, submitted.seen);
    expect(completed.agents[0].status).toBe("done");
  });

  test("removed panes and malformed stored entries are discarded", () => {
    const projected = projectCompletionAttention([agent("p2", "done")], { p1: "done" }, { p1: true, p2: true });
    expect(projected.seen).toEqual({ p2: true });
    expect(parseSeenCompletions('{"p1":true,"p2":false,"":true}')).toEqual({ p1: true });
    expect(parseSeenCompletions("not json")).toEqual({});
  });

  test("stored pane ids cannot affect object prototypes", () => {
    const parsed = parseSeenCompletions('{"__proto__":true,"constructor":true}');
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed, "constructor")).toBe(true);
  });
});
