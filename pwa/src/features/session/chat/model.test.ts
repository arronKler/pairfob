import { describe, expect, test } from "bun:test";
import { agentEmptySpec, agentStreamSignature, type AgentEmptyCopy } from "./model";

const copy: AgentEmptyCopy = {
  running: "running",
  reading: "reading",
  noChat: "no chat",
  terminalHint: "see terminal",
  sendBelow: "send below",
  cantSend: "cannot send",
};

describe("agent chat empty spec", () => {
  test("maps load, working, and sendability into the empty panel", () => {
    expect(agentEmptySpec({
      working: false, loadState: "error", note: "boom", unavailableNote: "gone", canSend: true, copy,
    })).toEqual({ kind: "error", title: "boom" });
    expect(agentEmptySpec({
      working: true, loadState: "ready", note: "", unavailableNote: "gone", canSend: true, copy,
    })).toEqual({ kind: "working", title: "running" });
    expect(agentEmptySpec({
      working: false, loadState: "cold", note: "", unavailableNote: "gone", canSend: true, copy,
    })).toEqual({ kind: "loading", title: "reading" });
    expect(agentEmptySpec({
      working: false, loadState: "ready", note: "gone", unavailableNote: "gone", canSend: true, copy,
    })).toEqual({ kind: "unavailable", title: "gone", sub: "see terminal" });
    expect(agentEmptySpec({
      working: false, loadState: "ready", note: "hint", unavailableNote: "gone", canSend: true, copy,
    })).toEqual({ kind: "empty", title: "no chat", sub: "hint" });
    expect(agentEmptySpec({
      working: false, loadState: "ready", note: "", unavailableNote: "gone", canSend: true, copy,
    })).toEqual({ kind: "empty", title: "no chat", sub: "send below" });
    expect(agentEmptySpec({
      working: false, loadState: "ready", note: "", unavailableNote: "gone", canSend: false, copy,
    })).toEqual({ kind: "empty", title: "no chat", sub: "cannot send" });
  });
});

describe("agent stream signature", () => {
  test("includes items, working, load, truncation, and detail revision", () => {
    expect(agentStreamSignature([{ type: "user" }], true, "ready", false, 3))
      .toBe('[{"type":"user"}]|1|ready|0|3');
    expect(agentStreamSignature([], false, "cold", true, 0)).toBe("[]|0|cold|1|0");
  });
});
