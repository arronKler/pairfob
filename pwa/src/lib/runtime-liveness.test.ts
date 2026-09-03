import { describe, expect, test } from "bun:test";
import { runtimeLiveness, type RuntimeLivenessInput } from "./runtime-liveness";

function input(overrides: Partial<RuntimeLivenessInput>): RuntimeLivenessInput {
  return { connected: true, networkOnline: true, runtimeKind: "herdr", ...overrides };
}

describe("runtimeLiveness", () => {
  test("connected phone with a reachable Herdr is live", () => {
    expect(runtimeLiveness(input({ runtimeKind: "herdr" }))).toBe("live");
  });

  test("connected phone with the demo runtime is live", () => {
    expect(runtimeLiveness(input({ runtimeKind: "fake" }))).toBe("live");
  });

  test("connected phone whose Herdr reports offline is exited", () => {
    expect(runtimeLiveness(input({ runtimeKind: "offline" }))).toBe("exited");
  });

  test("phone without network is unverifiable even with a connected session", () => {
    expect(runtimeLiveness(input({ networkOnline: false, runtimeKind: "herdr" }))).toBe("unverifiable");
    expect(runtimeLiveness(input({ networkOnline: false, runtimeKind: "offline" }))).toBe("unverifiable");
  });

  test("no session or dropped transport is unverifiable, never exited", () => {
    expect(runtimeLiveness(input({ connected: false, runtimeKind: "herdr" }))).toBe("unverifiable");
    expect(runtimeLiveness(input({ connected: false, runtimeKind: "offline" }))).toBe("unverifiable");
    expect(runtimeLiveness(input({ connected: false, runtimeKind: "" }))).toBe("unverifiable");
  });

  test("connected session with unknown runtime kind is unverifiable", () => {
    expect(runtimeLiveness(input({ runtimeKind: "" }))).toBe("unverifiable");
    expect(runtimeLiveness(input({ runtimeKind: "something-new" }))).toBe("unverifiable");
  });

  test("only ever returns one of the three verdicts", () => {
    const kinds = ["herdr", "fake", "offline", "", "weird"];
    for (const connected of [true, false]) {
      for (const networkOnline of [true, false]) {
        for (const runtimeKind of kinds) {
          const verdict = runtimeLiveness({ connected, networkOnline, runtimeKind });
          expect(["live", "unverifiable", "exited"]).toContain(verdict);
          if (!connected || !networkOnline) expect(verdict).toBe("unverifiable");
          else if (runtimeKind === "herdr" || runtimeKind === "fake") expect(verdict).toBe("live");
          else if (runtimeKind === "offline") expect(verdict).toBe("exited");
          else expect(verdict).toBe("unverifiable");
        }
      }
    }
  });
});
