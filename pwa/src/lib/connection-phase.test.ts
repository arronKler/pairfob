import { describe, expect, test } from "bun:test";
import { connectionPhaseOf } from "./connection-phase";

describe("connection phase", () => {
  test("a session that reports its phase wins over the fallbacks", () => {
    const session = {
      connectionPhase: () => "verifying" as const,
      isConnected: () => true,
      isChecking: () => false,
    };
    expect(connectionPhaseOf(session)).toBe("verifying");
  });

  test("without a phase, connected wins over checking", () => {
    expect(connectionPhaseOf({ isConnected: () => true, isChecking: () => true })).toBe("connected");
    expect(connectionPhaseOf({ isConnected: () => false, isChecking: () => true })).toBe("connecting");
    expect(connectionPhaseOf({ isConnected: () => false, isChecking: () => false })).toBe("disconnected");
  });

  test("a missing session is disconnected", () => {
    expect(connectionPhaseOf(null)).toBe("disconnected");
    expect(connectionPhaseOf(undefined)).toBe("disconnected");
  });
});