import { describe, expect, test } from "bun:test";
import { parseMachineLink, parseMachineList } from "./machine-link.ts";

describe("machine link results", () => {
  test("lists machines by opaque id and remembers their daemon", () => {
    expect(parseMachineList({
      machines: [
        { id: "b492e53d04afc5b0c9e552a6d886bc2b", label: "Build machine", state: "available", daemon_id: "d_84e96fc860788018e276" },
        { id: "off", label: "", state: "disabled" },
      ],
    })).toEqual([
      { id: "b492e53d04afc5b0c9e552a6d886bc2b", label: "Build machine", state: "available", daemonId: "d_84e96fc860788018e276" },
      { id: "off", label: "", state: "disabled" },
    ]);
  });

  test("rejects machine rows that leak how the machine is reached", () => {
    const row = { id: "m1", label: "Build machine", state: "available" };
    for (const machines of [
      [{ ...row, target: "ssh://dev@workbox" }],
      [{ ...row, id: "ssh://dev@workbox" }],
      [{ ...row, state: "linked" }],
      [{ ...row, daemon_id: "workbox" }],
      [row, row],
      "m1",
    ]) {
      expect(() => parseMachineList({ machines })).toThrow();
    }
    expect(() => parseMachineList({ machines: [], next: 1 })).toThrow();
  });

  test("carries a pairing link only while offering and an error only when failed", () => {
    const base = { operation_id: "op_aaaaaaaaaaaaaaaa", machine_id: "m1" };
    expect(parseMachineLink({ operation_id: "", machine_id: "", phase: "idle" })).toEqual({ operationId: "", machineId: "", phase: "idle" });
    expect(parseMachineLink({ ...base, phase: "offering", pair_url: "https://pairfob.com/pair#c=7K3M9H2P" })).toEqual({
      operationId: base.operation_id, machineId: "m1", phase: "offering", pairUrl: "https://pairfob.com/pair#c=7K3M9H2P",
    });
    expect(parseMachineLink({ ...base, phase: "failed", error: "unreachable" }).error).toBe("unreachable");
    for (const bad of [
      { ...base, phase: "paired", pair_url: "https://pairfob.com/pair#c=7K3M9H2P" },
      { ...base, phase: "offering", pair_url: "x".repeat(513) },
      { ...base, phase: "checking", error: "unreachable" },
      { ...base, phase: "failed", error: "ssh: permission denied for dev@workbox" },
      { ...base, phase: "done" },
      { ...base, phase: "checking", target: "workbox" },
      { machine_id: "m1", phase: "checking" },
    ]) {
      expect(() => parseMachineLink(bad)).toThrow();
    }
  });
});
